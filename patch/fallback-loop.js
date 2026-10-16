import fs from "node:fs";
let cachedSmartConfig = null;
let lastSmartConfigRead = 0;
function getSmartFallbackConfig() {
  const now = Date.now();
  if (cachedSmartConfig && now - lastSmartConfigRead < 2e3) return cachedSmartConfig;
  const configPath = process.env.FALLBACK_CONFIG_PATH || "/config/fallback-config.json";
  try {
    if (fs.existsSync(configPath)) {
      cachedSmartConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      lastSmartConfigRead = now;
      return cachedSmartConfig;
    }
  } catch {
  }
  return {
    waitAndRetryRpm: true,
    maxWaitSeconds: 15,
    jitterMs: 250,
    rotateOnlyOnDailyQuota: true,
    preFlightTpmCheck: true,
    strictSingleProvider: true
  };
}
import { nextMonthResetAt } from "../services/key-budget.js";
import { recordRateLimitHit, recordModelFailure, recordSuccess, hasOtherUsableKey, routableKeyIdsForModel, formatResetEta } from "../services/router.js";
import { safeHeaderValue } from "./header-value.js";
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getActiveCooldownsForKeys,
  getCooldownDecisionForLimit,
  getSoonestCooldownExpiry,
  getPaymentRequiredCooldownMs,
  getModelForbiddenCooldownMs,
  learnLimitFromError,
  learnContextWindowFromError
} from "../services/ratelimit.js";
import {
  isRetryableError,
  isRateLimitSignal,
  isKeyAuthError,
  isClientAbortError,
  isHedgeAbortError,
  isDailyQuotaExhaustedError,
  isPaymentRequiredError,
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isAccountSuspendedError,
  isProviderBadRequestError,
  isProviderDegradedError,
  isProviderLevelError,
  isContextTooLargeError,
  isTimeoutErrorText,
  isStreamTruncatedError
} from "./error-classify.js";
import { sanitizeProviderErrorMessage, summarizeAttemptError } from "./error-redaction.js";
import { benchForTools, clearToolRejections, noteToolRejection, toolCapabilityKey } from "./tool-capability.js";
import { parseProviderReportedSize } from "./provider-size-parser.js";
import { checkKeyHealth, markKeyHealthyFromRequest } from "../services/health.js";
import { noteModelRetirementSignal } from "../services/model-retirement.js";
import { getDb, getSetting } from "../db/index.js";
import { newBreaker, recordBreakerFailure } from "./guardrails.js";
import { getRequestTrace, newRequestTrace, runWithRequestTrace } from "./attempt-trace.js";
import { logRequest, persistRequestAttempts } from "./request-log.js";
import { withKeyProxy } from "./proxy.js";
import { getEndpointTimeBudgetMs } from "./ttfb-budget.js";
import { learnOutputCapFromError, learnedOutputCap } from "./output-cap.js";
const FALLBACK_MAX_RETRIES = 20;
const MODEL_FAILURE_WINDOW_MS = 15 * 60 * 1e3;
const MODEL_FAILURE_THRESHOLD = 3;
const MODEL_FAILURE_COOLDOWN_MS = 10 * 60 * 1e3;
const modelFailureTimestamps = /* @__PURE__ */ new Map();
function noteModelFailure(route, now) {
  const window = (modelFailureTimestamps.get(route.modelDbId) ?? []).filter((t) => now - t < MODEL_FAILURE_WINDOW_MS);
  window.push(now);
  modelFailureTimestamps.set(route.modelDbId, window);
  if (window.length < MODEL_FAILURE_THRESHOLD) return;
  const keyIds = routableKeyIdsForModel(route.modelDbId);
  const targets = keyIds.length > 0 ? keyIds : [route.keyId];
  const benchUntil = now + MODEL_FAILURE_COOLDOWN_MS;
  const active = getActiveCooldownsForKeys(targets, now);
  for (const keyId of targets) {
    const current = active.get(keyId)?.find((c) => c.platform === route.platform && c.modelId === route.modelId);
    if (current && current.expiresAtMs >= benchUntil) continue;
    setCooldown(route.platform, route.modelId, keyId, MODEL_FAILURE_COOLDOWN_MS, "heuristic");
  }
  modelFailureTimestamps.delete(route.modelDbId);
}
function clearModelFailure(route) {
  modelFailureTimestamps.delete(route.modelDbId);
}
function benchKeyAcrossPlatform(route, durationMs, source, state, reason) {
  let modelIds = [];
  try {
    modelIds = getDb().prepare(
      "SELECT model_id FROM models WHERE platform = ? AND enabled = 1 AND (key_id IS NULL OR key_id = ?)"
    ).all(route.platform, route.keyId).map((r) => r.model_id);
  } catch (dbErr) {
    console.warn(`[FallbackLoop] could not list ${route.platform} models to bench key ${route.keyId}: ${dbErr?.message ?? dbErr}`);
    return;
  }
  let benched = 0;
  for (const modelId of modelIds) {
    if (modelId === route.modelId) continue;
    setCooldown(route.platform, modelId, route.keyId, durationMs, source);
    state.skipKeys.add(`${route.platform}:${modelId}:${route.keyId}`);
    benched++;
  }
  console.warn(`[FallbackLoop] ${route.platform} key ${route.keyId} ${reason}; benched it on ${benched + 1} model(s) for ${Math.round(durationMs / 6e4)}min`);
}
const DEFAULT_FALLBACK_TIME_BUDGET_MS = 45e3;
const HEDGE_BENCH_MIN_SILENT_FRACTION = 0.75;
const FALLBACK_TIME_BUDGET_SETTING = "fallback_time_budget_ms";
function getFallbackTimeBudgetMs() {
  let stored;
  try {
    stored = getSetting(FALLBACK_TIME_BUDGET_SETTING);
  } catch {
    stored = void 0;
  }
  const candidates = [stored, process.env.FALLBACK_TIME_BUDGET_MS];
  for (const raw of candidates) {
    if (raw === void 0 || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_FALLBACK_TIME_BUDGET_MS;
}
function fallbackRoutingTokens(state, estimatedTotal, outputReserve) {
  return Math.max(
    estimatedTotal,
    state.observedTotalTokens ?? 0,
    state.observedInputTokens == null ? 0 : state.observedInputTokens + Math.max(0, outputReserve)
  );
}
function newFallbackState() {
  return { skipKeys: /* @__PURE__ */ new Set(), skipModels: /* @__PURE__ */ new Set(), skipPlatforms: /* @__PURE__ */ new Set(), modelNotFoundPlatforms: /* @__PURE__ */ new Map() };
}
const MODEL_NOT_FOUND_PLATFORM_LIMIT = 3;
function msUntilNextUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(next - now, 6e4);
}
const pacificDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "numeric",
  day: "numeric"
});
const pacificHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  hourCycle: "h23"
});
function msUntilNextPacificMidnight(now = Date.now()) {
  const parts = pacificDate.formatToParts(now);
  const part = (name) => Number(parts.find((p) => p.type === name).value);
  const candidate = Date.UTC(part("year"), part("month") - 1, part("day") + 1, 8);
  const midnight = candidate - Number(pacificHour.format(candidate)) * 36e5;
  return Math.max(midnight - now, 6e4);
}
function cooldownForError(route, err) {
  return cooldownDecisionForError(route, err).durationMs;
}
function cooldownDecisionForError(route, err) {
  if (isPaymentRequiredError(err)) return { durationMs: getPaymentRequiredCooldownMs(), source: "credit" };
  if (isAccountSuspendedError(err)) return { durationMs: getPaymentRequiredCooldownMs(), source: "credit" };
  if (isModelAccessForbiddenError(err)) return { durationMs: getModelForbiddenCooldownMs(), source: "tier" };
  if (isDailyQuotaExhaustedError(err)) {
    if (route.platform === "google") {
      return { durationMs: Math.max(msUntilNextPacificMidnight(), err?.retryAfterMs ?? 0), source: "authoritative" };
    }
    return { durationMs: err?.retryAfterMs ?? msUntilNextUtcMidnight(), source: "authoritative" };
  }
  return getCooldownDecisionForLimit(
    route.platform,
    route.modelId,
    route.keyId,
    { rpd: route.rpdLimit, tpd: route.tpdLimit },
    err?.retryAfterMs,
    // Only a real 429/rate-limit error may feed the null-limits exhaustion
    // heuristic; a timeout or 5xx is retryable but says nothing about quota,
    // so it stays on the short transient bench instead of the ladder (#592).
    { quotaSignal: isRateLimitSignal(err) }
  );
}
const TRUNCATION_STREAK_LIMIT = 3;
const TRUNCATION_BENCH_MS = 5 * 60 * 1e3;
const truncationStreaks = /* @__PURE__ */ new Map();
function resetTruncationStreaks() {
  truncationStreaks.clear();
}
const EMPTY_COMPLETION_STREAK_LIMIT = 3;
const emptyCompletionStreaks = /* @__PURE__ */ new Map();
function resetEmptyCompletionStreaks() {
  emptyCompletionStreaks.clear();
}
function resetModelFailureWindows() {
  modelFailureTimestamps.clear();
}
function clearModelFailureWindows() {
  const count = modelFailureTimestamps.size;
  modelFailureTimestamps.clear();
  return count;
}
function consumeSkipBenchExemption(route, err) {
  const key = `${route.platform}:${route.modelId}:${route.keyId}`;
  if (err?.skipBench !== true) {
    emptyCompletionStreaks.delete(key);
    return false;
  }
  if (err?.skipModelForRequest === true) return true;
  const streak = (emptyCompletionStreaks.get(key) ?? 0) + 1;
  emptyCompletionStreaks.set(key, streak);
  return streak < EMPTY_COMPLETION_STREAK_LIMIT;
}
function recordRetryableFailure(route, err, state, now = Date.now()) {
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err) || isContextTooLargeError(err) || err?.skipModelForRequest === true) {
    state.skipModels.add(route.modelDbId);
  }
  if (isModelNotFoundError(err) && !route.endpointScope) {
    const seen = state.modelNotFoundPlatforms.get(route.platform) ?? /* @__PURE__ */ new Set();
    seen.add(route.modelDbId);
    state.modelNotFoundPlatforms.set(route.platform, seen);
    if (seen.size >= MODEL_NOT_FOUND_PLATFORM_LIMIT) {
      state.skipPlatforms.add(route.platform);
    }
  }
  noteModelRetirementSignal(route, err, getRequestTrace());
  if (isContextTooLargeError(err) || isProviderBadRequestError(err)) {
    const reported = parseProviderReportedSize(route.platform, err?.message);
    if (reported != null) {
      const field = reported.kind === "input" ? "observedInputTokens" : "observedTotalTokens";
      state[field] = Math.max(state[field] ?? 0, reported.tokens);
    }
  }
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  if (isProviderLevelError(err)) {
    state.skipPlatforms.add(route.platform);
  }
  if (isContextTooLargeError(err)) {
    learnLimitFromError(route.modelDbId, err);
    learnContextWindowFromError(route.modelDbId, err);
    return false;
  }
  const capBefore = learnedOutputCap(route.platform, route.modelId, route.endpointScope);
  const ceiling = learnOutputCapFromError(route, err);
  if (ceiling != null) {
    if (capBefore == null || ceiling < capBefore) {
      state.skipKeys.delete(`${route.platform}:${route.modelId}:${route.keyId}`);
    } else {
      state.skipModels.add(route.modelDbId);
    }
    return false;
  }
  if (consumeSkipBenchExemption(route, err)) return true;
  const decision = cooldownDecisionForError(route, err);
  setCooldown(route.platform, route.modelId, route.keyId, decision.durationMs, decision.source);
  if (isStreamTruncatedError(err)) {
    const tk = `${route.platform}:${route.modelId}:${route.keyId}`;
    const streak = (truncationStreaks.get(tk) ?? 0) + 1;
    if (streak >= TRUNCATION_STREAK_LIMIT) {
      truncationStreaks.delete(tk);
      setCooldown(route.platform, route.modelId, route.keyId, TRUNCATION_BENCH_MS, "heuristic");
      console.warn(`[FallbackLoop] ${route.platform} ${route.modelId} key ${route.keyId}: ${streak} consecutive truncated streams \u2014 benching the route for ${Math.round(TRUNCATION_BENCH_MS / 1e3)}s`);
    } else {
      truncationStreaks.set(tk, streak);
    }
  } else {
    truncationStreaks.delete(`${route.platform}:${route.modelId}:${route.keyId}`);
  }
  if (state.wantsTools === true && classifyAttemptError(err) === "provider_bad_request") {
    const tk = toolCapabilityKey(route.platform, route.modelId, route.endpointScope);
    const seen = state.toolRejects ??= /* @__PURE__ */ new Set();
    if (!seen.has(tk)) {
      seen.add(tk);
      noteToolRejection(tk, now);
    }
  }
  if (isAccountSuspendedError(err)) {
    state.skipPlatforms.add(route.platform);
    benchKeyAcrossPlatform(route, decision.durationMs, decision.source, state, "reports the account suspended");
  } else if (isPaymentRequiredError(err)) {
    benchKeyAcrossPlatform(route, decision.durationMs, decision.source, state, "is out of credits (402)");
  }
  noteModelFailure(route, now);
  if (!hasOtherUsableKey(route.modelDbId, route.keyId, state.skipKeys)) {
    if (isRateLimitSignal(err)) {
      recordRateLimitHit(route.modelDbId);
    } else {
      recordModelFailure(route.modelDbId);
    }
  }
  learnLimitFromError(route.modelDbId, err);
  return false;
}
const AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1e3;
const REVALIDATION_DEDUPE_MS = 3e4;
const lastRevalidation = /* @__PURE__ */ new Map();
function triggerKeyRevalidation(platform, keyId) {
  const now = Date.now();
  const last = lastRevalidation.get(keyId) ?? 0;
  if (now - last < REVALIDATION_DEDUPE_MS) return;
  lastRevalidation.set(keyId, now);
  console.warn(`[FallbackLoop] Upstream 401 from ${platform} key ${keyId}; revalidating it now instead of waiting for the health cycle`);
  void checkKeyHealth(keyId).catch((err) => {
    console.error(`[FallbackLoop] Immediate revalidation of key ${keyId} failed:`, err?.message);
  });
}
function recordAuthFailure(route, state) {
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  setCooldown(route.platform, route.modelId, route.keyId, AUTH_FAILURE_COOLDOWN_MS);
  triggerKeyRevalidation(route.platform, route.keyId);
}
function recordUpstreamSuccess(route, rateLimitTokens, state) {
  if (state?.wantsTools === true) {
    const winner = toolCapabilityKey(route.platform, route.modelId, route.endpointScope);
    clearToolRejections(winner);
    for (const tk of state.toolRejects ?? []) if (tk !== winner) benchForTools(tk);
  }
  recordRequest(route.platform, route.modelId, route.keyId);
  recordTokens(route.platform, route.modelId, route.keyId, rateLimitTokens);
  recordSuccess(route.modelDbId);
  emptyCompletionStreaks.delete(`${route.platform}:${route.modelId}:${route.keyId}`);
  truncationStreaks.delete(`${route.platform}:${route.modelId}:${route.keyId}`);
  clearModelFailure(route);
  markKeyHealthyFromRequest(route.keyId);
}
function classifyAttemptError(err) {
  if (isKeyAuthError(err)) return "auth";
  if (isPaymentRequiredError(err)) return "out_of_credits";
  if (isDailyQuotaExhaustedError(err)) return "daily_quota_exhausted";
  if (isModelNotFoundError(err)) return "model_not_found";
  if (isModelAccessForbiddenError(err)) return "forbidden";
  if (isContextTooLargeError(err)) return "context_too_large";
  if (isProviderDegradedError(err)) return "upstream_error";
  if (isProviderBadRequestError(err)) return "provider_bad_request";
  const msg = (err?.message ?? "").toLowerCase();
  if (msg.includes("empty completion")) return "empty_completion";
  if (msg.includes("ignored response_format") || msg.includes("truncated json")) return "format_ignored";
  if (msg.includes("invalid tool arguments")) return "invalid_tool_arguments";
  if (isTimeoutErrorText(msg)) return "timeout";
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) return "rate_limited";
  const status = typeof err?.status === "number" ? err.status : 0;
  if (status >= 500 || msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("unavailable") || msg.includes("internal server error")) return "upstream_error";
  return "error";
}
const TRAIL_MAX_SHOWN = 10;
const TRAIL_HEADER_MAX_LENGTH = 1024;
const EXPOSE_FALLBACK_DETAIL_SETTING = "expose_fallback_detail_header";
const DETAIL_HEADER_MAX_LENGTH = 2048;
const DETAIL_SUMMARY_MAX_LENGTH = 120;
function isFallbackDetailHeaderEnabled() {
  let stored;
  try {
    stored = getSetting(EXPOSE_FALLBACK_DETAIL_SETTING);
  } catch {
    stored = void 0;
  }
  for (const raw of [stored, process.env.FALLBACK_DETAIL_HEADER]) {
    if (raw === void 0 || raw.trim() === "") continue;
    const value = raw.trim().toLowerCase();
    return value === "1" || value === "true";
  }
  return false;
}
function formatAttemptDetail(records) {
  const shown = records.slice(0, TRAIL_MAX_SHOWN).map((r) => {
    const parts = [
      `${r.platform}/${r.modelId}`,
      `key${r.keyOrdinal}=${r.outcome}`,
      `t=${r.startOffsetMs}+${r.durationMs}ms`
    ];
    if (r.errorSummary) {
      parts.push(`msg=${r.errorSummary.slice(0, DETAIL_SUMMARY_MAX_LENGTH).replace(/;/g, ",")}`);
    }
    return parts.join(" ");
  });
  const extra = records.length - shown.length;
  return shown.join("; ") + (extra > 0 ? `; +${extra} more` : "");
}
function formatAttemptTrail(attempts) {
  const shown = attempts.slice(0, TRAIL_MAX_SHOWN).map((a) => `${a.platform}/${a.modelId} key${a.keyOrdinal}: ${a.errorClass}`);
  const extra = attempts.length - shown.length;
  return shown.join("; ") + (extra > 0 ? `; +${extra} more` : "");
}
function setFallbackHeaders(res, failedAttempts, trail) {
  if (failedAttempts > 0) res.setHeader("X-Fallback-Attempts", String(failedAttempts));
  if (trail && trail.length > 0) {
    const value = trail.slice(0, TRAIL_MAX_SHOWN).map((a) => `${a.platform}/${a.modelId} key${a.keyOrdinal}=${a.errorClass}`).join("; ") + (trail.length > TRAIL_MAX_SHOWN ? `; +${trail.length - TRAIL_MAX_SHOWN} more` : "");
    res.setHeader("X-Fallback-Trail", safeHeaderValue(value, TRAIL_HEADER_MAX_LENGTH));
  }
  const records = getRequestTrace()?.records;
  if (records && records.length > 0 && isFallbackDetailHeaderEnabled()) {
    res.setHeader("X-Fallback-Detail", safeHeaderValue(formatAttemptDetail(records), DETAIL_HEADER_MAX_LENGTH));
  }
}
function exhaustionErrorPayload(body) {
  const payload = {
    message: body.message,
    type: body.type
  };
  if (body.code) payload.code = body.code;
  if (body.retryAtMs != null) payload.retryAtMs = body.retryAtMs;
  return payload;
}
function setExhaustionHeaders(res, body, now = Date.now()) {
  if (body.retryAtMs == null) return;
  res.setHeader("Retry-After", String(Math.max(0, Math.ceil((body.retryAtMs - now) / 1e3))));
}
const UNAVAILABLE_UNTIL_KNOWN_TIME = /* @__PURE__ */ new Set([
  "rate_limited",
  "daily_quota_exhausted",
  "out_of_credits",
  "forbidden"
]);
function exhaustedRetryError(lastError, maxRetries, ctx) {
  const safeLastError = sanitizeProviderErrorMessage(lastError?.message);
  const attempts = ctx?.attempts ?? [];
  const trail = attempts.length > 0 ? ` Attempt trail: ${formatAttemptTrail(attempts)}.` : "";
  const budgetNote = ctx?.timedOut ? ` (stopped early: retry time budget ${Math.round((ctx.budgetMs ?? 0) / 1e3)}s exceeded \u2014 one failover hop is always allowed, and past that the budget stops starting further retries and cancels an attempt still waiting on its first byte; raise FALLBACK_TIME_BUDGET_MS or the fallback_time_budget_ms setting to allow a longer failover chain)` : "";
  const everyAttempt = (cls) => attempts.length > 0 && attempts.every((a) => cls instanceof Set ? cls.has(a.errorClass) : a.errorClass === cls);
  if (everyAttempt("auth")) {
    return {
      kind: "auth",
      status: 502,
      type: "provider_error",
      code: "provider_authentication_failed",
      message: `All ${attempts.length} attempted provider key(s) failed authentication${budgetNote}. The configured upstream API key(s) look invalid or expired; they are being revalidated now and will be marked invalid automatically. Check the provider keys in the dashboard.${trail} Last error: ${safeLastError}`
    };
  }
  if (everyAttempt("context_too_large")) {
    return {
      kind: "context_too_large",
      status: 413,
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: `The request is too large for every routed candidate: all ${attempts.length} attempt(s) were rejected as over the model's context/size limit${budgetNote}. Retrying will not help \u2014 reduce the prompt/history size or enable a larger-context model.${trail} Last error: ${safeLastError}`
    };
  }
  if (everyAttempt("model_not_found")) {
    return {
      kind: "model_not_found",
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      message: `Every routed provider reports the model as not found or removed upstream (${attempts.length} attempt(s))${budgetNote}. The catalog entry looks stale; pick another model or call /v1/models for the available list.${trail} Last error: ${safeLastError}`
    };
  }
  if (isProviderDegradedError(lastError)) {
    return {
      kind: "unavailable",
      status: 503,
      type: "service_unavailable",
      code: "provider_degraded",
      message: `The routed provider reported the model's hosted deployment as temporarily degraded${budgetNote}. This is a provider-side condition; retry later or route to another provider.${trail} Last error: ${safeLastError}`
    };
  }
  if (isProviderBadRequestError(lastError) && (attempts.length === 0 || everyAttempt("provider_bad_request"))) {
    return {
      kind: "bad_request",
      status: 400,
      type: "invalid_request_error",
      code: "provider_rejected_request",
      message: `All routed providers rejected the request as invalid${budgetNote}.${trail} Last error: ${safeLastError}`
    };
  }
  if (ctx?.breakerFails) {
    const breakerEta = formatResetEta(getSoonestCooldownExpiry());
    const breakerEtaNote = breakerEta ? ` Soonest cooldown reset ${breakerEta}.` : "";
    return {
      kind: "unavailable",
      status: 503,
      type: "service_unavailable",
      code: "upstream_unhealthy",
      message: `Failover stopped early by the circuit-breaker guardrail: ${ctx.breakerFails} consecutive upstream failure${ctx.breakerFails === 1 ? "" : "s"} (max_consecutive_upstream_fails). The enabled pool looks unhealthy right now, so the remaining candidates were skipped instead of burning quota on them.${breakerEtaNote}${trail} Last error: ${safeLastError}`
    };
  }
  if (attempts.length === 0 || everyAttempt(UNAVAILABLE_UNTIL_KNOWN_TIME)) {
    const attemptCount = attempts.length > 0 ? attempts.length : maxRetries;
    const scope = attemptCount == null ? "All models rate-limited" : `All models rate-limited after ${attemptCount} attempt${attemptCount === 1 ? "" : "s"}`;
    const retryAtMs = getSoonestCooldownExpiry() ?? void 0;
    const eta = formatResetEta(retryAtMs);
    const etaNote = eta ? ` Soonest cooldown reset ${eta}.` : "";
    return {
      kind: "rate_limit",
      status: 429,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      ...retryAtMs != null ? { retryAtMs } : {},
      message: `${scope}${budgetNote}.${etaNote}${trail} Last error: ${safeLastError}`
    };
  }
  const breakdown = formatClassBreakdown(attempts);
  const someBadRequest = attempts.some((a) => a.errorClass === "provider_bad_request");
  const verdict = someBadRequest ? "Most of these failures are provider-side (stale models, exhausted credits or quotas), but some providers also rejected the request shape \u2014 check the attempt trail for which ones before changing your request." : "This is a provider-side failure, not a problem with your request; retry, or check provider status.";
  return {
    kind: "upstream",
    status: 502,
    type: "provider_error",
    code: "upstream_failed",
    message: `All ${attempts.length} routed attempt(s) failed with upstream provider errors${breakdown}${budgetNote}. ${verdict}${trail} Last error: ${safeLastError}`
  };
}
function formatClassBreakdown(attempts) {
  if (attempts.length === 0) return "";
  const counts = /* @__PURE__ */ new Map();
  for (const a of attempts) counts.set(a.errorClass, (counts.get(a.errorClass) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cls, n]) => `${cls} \xD7${n}`);
  return ` (${parts.join(", ")})`;
}
function classifyRoutingDiagLine(line) {
  const l = line.toLowerCase();
  if (l.includes("< estimated")) return "too_large";
  const monthlyReasons = l.match(/key\(s\) — (.*)$/)?.[1];
  if (monthlyReasons?.split(", ").every((reason) => /^monthly-budget-cap:\d+$/.test(reason))) return "monthly_budget";
  if (/no provider registered|no enabled\+healthy key|no usable key|decrypt-error|no-resolved-provider|custom-key-mismatch/.test(l)) return "config";
  if (/cooldown|rpm|rpd|tpm|tpd|provider-daily-cap|provider-minute-cap|provider-daily-token-cap|key-concurrency|monthly-budget-cap/.test(l)) return "time_bound";
  return "other";
}
function routingExhaustionBody(routeErr) {
  const diag = Array.isArray(routeErr?.diagnostics) ? routeErr.diagnostics : [];
  const message = routeErr?.message ?? "No model available to route this request";
  const classes = diag.map(classifyRoutingDiagLine);
  if (diag.length === 0 || classes.every((c) => c === "config")) {
    return {
      kind: "unavailable",
      status: 503,
      type: "service_unavailable",
      code: "no_providers_configured",
      message: diag.length === 0 ? `No models are enabled/configured to serve this request. Add provider API keys and enable models in the dashboard. ${message}` : `No candidate model has a configured, usable provider key. Add provider API keys in the dashboard. ${message}`
    };
  }
  if (classes.every((c) => c === "too_large" || c === "config") && classes.includes("too_large")) {
    return {
      kind: "context_too_large",
      status: 413,
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: `The request is too large for every available candidate's context/token window. Reduce the prompt/history size or enable a larger-context model. ${message}`
    };
  }
  if (classes.includes("monthly_budget") && classes.every((c) => c === "monthly_budget" || c === "config" || c === "too_large")) {
    return {
      kind: "rate_limit",
      status: 429,
      type: "rate_limit_error",
      code: "quota_exceeded",
      retryAtMs: Date.parse(nextMonthResetAt()),
      message: `Monthly key budget exhausted. Raise the cap or wait until the next UTC month. ${message}`
    };
  }
  if (classes.some((c) => c === "time_bound") && classes.every((c) => c !== "other")) {
    const retryAtMs = getSoonestCooldownExpiry() ?? void 0;
    return {
      kind: "rate_limit",
      status: 429,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      ...retryAtMs != null ? { retryAtMs } : {},
      message
    };
  }
  return {
    kind: "rate_limit",
    status: typeof routeErr?.status === "number" ? routeErr.status : 429,
    type: "rate_limit_error",
    code: "routing_exhausted",
    message
  };
}
function logRoutingExhaustion(routeErr, identity) {
  const disposition = Array.isArray(routeErr?.diagnostics) ? routeErr.diagnostics : [];
  const surface = identity?.surface ?? "unidentified surface";
  const req = identity?.requestId ? ` req=${identity.requestId.replace(/-/g, "").slice(0, 6)}` : "";
  const requested = identity?.requestedModel ? ` requested=${identity.requestedModel}` : "";
  console.warn(
    `[FallbackLoop] ${surface} routing exhausted (no upstream tried)${req}${requested} candidates=${disposition.length}` + (disposition.length ? `:
  ${disposition.join("\n  ")}` : "")
  );
}
async function runFallbackLoop(hooks) {
  const trace = newRequestTrace();
  try {
    await runWithRequestTrace(trace, () => runFallbackLoopAttempts(hooks, trace));
  } finally {
    persistRequestAttempts(trace);
  }
}
async function runFallbackLoopAttempts(hooks, trace) {
  const maxRetries = hooks.maxRetries ?? FALLBACK_MAX_RETRIES;
  const baseBudgetMs = hooks.timeBudgetMs ?? getFallbackTimeBudgetMs();
  const startedAt = Date.now();
  const attempts = hooks.attemptLog ?? [];
  const keyOrdinals = /* @__PURE__ */ new Map();
  const keyOrdinal = (route) => {
    const key = `${route.platform}:${route.keyId}`;
    let ord = keyOrdinals.get(key);
    if (ord === void 0) {
      ord = keyOrdinals.size + 1;
      keyOrdinals.set(key, ord);
    }
    return ord;
  };
  let lastError = null;
  let initialPlatform;
  const breaker = newBreaker(hooks.breakerLimit);
  const stopIfBreakerTripped = () => {
    if (!recordBreakerFailure(breaker)) return false;
    if (hooks.clientGone?.()) {
      console.log(`[FallbackLoop] breaker tripped after client disconnect \u2014 stopping without rendering (${attempts.length} failed attempt(s))`);
      return true;
    }
    hooks.onExhausted(
      exhaustedRetryError(lastError, maxRetries, { attempts, breakerFails: breaker.consecutive }),
      { attempts, timedOut: false }
    );
    return true;
  };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0 && hooks.clientGone?.()) {
      console.log(`[FallbackLoop] client disconnected \u2014 stopping failover after ${attempts.length} failed attempt(s)`);
      return;
    }
    let route;
    try {
      route = hooks.route(attempt);
      if (attempt === 0) {
        initialPlatform = route.platform;
      } else {
        const smartCfg = getSmartFallbackConfig();
        if (smartCfg.strictSingleProvider && initialPlatform && route.platform !== initialPlatform) {
          console.warn(`[SmartFallback] Strict Single-Provider: bloccato cambio provider da ${initialPlatform} a ${route.platform}`);
          const exhaustion = exhaustedRetryError(lastError, maxRetries, { attempts });
          hooks.onExhausted(exhaustion, { attempts, timedOut: false });
          return;
        }
      }
    } catch (routeErr) {
      if (attempt > 1 && baseBudgetMs > 0 && Date.now() - startedAt >= baseBudgetMs) {
        hooks.onExhausted(
          exhaustedRetryError(lastError, maxRetries, { attempts, timedOut: true, budgetMs: baseBudgetMs }),
          { attempts, timedOut: true }
        );
        return;
      }
      const exhaustion = lastError ? exhaustedRetryError(lastError, void 0, { attempts }) : routingExhaustionBody(routeErr);
      if (!lastError) logRoutingExhaustion(routeErr, hooks.logIdentity);
      hooks.onRoutingExhausted(lastError, routeErr, exhaustion, { attempts, timedOut: false });
      return;
    }
    let hedgeTimer;
    try {
      const budgetMs = attempt > 1 ? getEndpointTimeBudgetMs(baseBudgetMs, route.platform, route.endpointScope) : baseBudgetMs;
      if (attempt > 1 && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
        hooks.onExhausted(
          exhaustedRetryError(lastError, maxRetries, { attempts, timedOut: true, budgetMs }),
          { attempts, timedOut: true }
        );
        return;
      }
      const attemptStartedAt = Date.now();
      const traceAttempt = (outcome2, err) => {
        trace.records.push({
          ordinal: trace.records.length,
          platform: route.platform,
          modelId: route.modelId,
          keyOrdinal: keyOrdinal(route),
          keyLabel: route.keyLabel ?? null,
          outcome: outcome2,
          startOffsetMs: attemptStartedAt - startedAt,
          durationMs: Date.now() - attemptStartedAt,
          errorSummary: err != null ? summarizeAttemptError(err?.message) : null
        });
      };
      const disarmHedge = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = void 0;
        }
      };
      if (attempt > 1 && budgetMs > 0 && hooks.abortInFlight) {
        const remaining = budgetMs - (Date.now() - startedAt);
        if (remaining > 0) {
          hedgeTimer = setTimeout(() => {
            console.log(`[FallbackLoop] retry time budget (${budgetMs}ms) expired with no first byte on ${route.platform}/${route.modelId} \u2014 aborting stalled upstream`);
            hooks.abortInFlight?.();
          }, remaining);
        }
      }
      const preFlightCfg = getSmartFallbackConfig();
      if (preFlightCfg.preFlightTpmCheck) {
        const estimatedTokens = fallbackRoutingTokens(hooks.state, 0, 0);
        if (route.tpmLimit && route.tpmLimit > 0 && estimatedTokens > route.tpmLimit) {
          console.warn(`[SmartFallback] Pre-Flight Check: la richiesta stima circa ${estimatedTokens} token, ma il modello ${route.modelId} ha un limite di ${route.tpmLimit} TPM. Richiesta bloccata prima della chiamata.`);
          const preFlightErr = new Error(`Pre-Flight TPM Check: la richiesta stima circa ${estimatedTokens} token, superando il limite di ${route.tpmLimit} TPM configurato per ${route.modelId}.`);
          preFlightErr.status = 413;
          traceAttempt("context_too_large", preFlightErr);
          hooks.onFatal(route, preFlightErr, attempt);
          return;
        }
      }
      let outcome;
      try {
        outcome = await withKeyProxy(route.proxyUrl, () => hooks.dispatch(route, attempt, { disarmHedge }));
      } catch (err) {
        if (isClientAbortError(err)) {
          const elapsedMs = Date.now() - startedAt;
          console.log(`[FallbackLoop] client disconnected mid-attempt on ${route.platform}/${route.modelId} \u2014 upstream canceled, stopping without benching`);
          logRequest(
            route.platform,
            route.modelId,
            route.keyId,
            "canceled",
            0,
            0,
            elapsedMs,
            `client disconnected after ${(elapsedMs / 1e3).toFixed(1)}s; upstream request canceled`
          );
          traceAttempt("client_abort");
          return;
        }
        if (isHedgeAbortError(err)) {
          const elapsedMs = Date.now() - startedAt;
          const attemptElapsedMs = Date.now() - attemptStartedAt;
          const ownedWholeBudget = budgetMs > 0 && attemptElapsedMs >= budgetMs * HEDGE_BENCH_MIN_SILENT_FRACTION;
          if (ownedWholeBudget) {
            hooks.logFailure(route, err, attempt);
            recordRetryableFailure(route, err, hooks.state);
          }
          console.log(`[FallbackLoop] retry time budget expired mid-attempt on ${route.platform}/${route.modelId} after ${(elapsedMs / 1e3).toFixed(1)}s \u2014 rendering timedOut exhaustion ${ownedWholeBudget ? `and benching the route (silent for the whole ${budgetMs}ms budget)` : "without benching"}`);
          hooks.onExhausted(
            exhaustedRetryError(lastError, maxRetries, { attempts, timedOut: true, budgetMs }),
            { attempts, timedOut: true }
          );
          traceAttempt("timeout", err);
          return;
        }
        hooks.logFailure(route, err, attempt);
        if (isKeyAuthError(err)) {
          recordAuthFailure(route, hooks.state);
          attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass: "auth" });
          traceAttempt("auth", err);
          lastError = err;
          if (stopIfBreakerTripped()) return;
          continue;
        }
        if (isRetryableError(err)) {
          const smartConfig = getSmartFallbackConfig();
          const isDailyExhausted = isDailyQuotaExhaustedError(err);
          const isRateLimit = isRateLimitSignal(err);
          if (smartConfig.waitAndRetryRpm && isRateLimit && !isDailyExhausted) {
            const statedWaitMs = err?.retryAfterMs ?? 5e3;
            const waitMs = statedWaitMs + (smartConfig.jitterMs ?? 250);
            const maxWaitMs = (smartConfig.maxWaitSeconds || 15) * 1e3;
            if (waitMs <= maxWaitMs) {
              console.log(`[SmartFallback] 429 RPM/TPM rilevato su ${route.platform}/${route.modelId} (chiave ${route.keyId}). Pausa in-place di ${(waitMs / 1e3).toFixed(1)}s sulla stessa chiave...`);
              await new Promise((r) => setTimeout(r, waitMs));
              const errorClass2 = classifyAttemptError(err);
              attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass: errorClass2 });
              traceAttempt(errorClass2, err);
              lastError = err;
              continue;
            } else {
              console.warn(`[SmartFallback] 429 RPM/TPM su ${route.platform}/${route.modelId}: attesa (${(waitMs / 1e3).toFixed(1)}s) supera maxWaitSeconds (${smartConfig.maxWaitSeconds}s).`);
              if (smartConfig.rotateOnlyOnDailyQuota) {
                console.warn(`[SmartFallback] Policy Anti-Burning attiva: rotazione chiavi bloccata su 429 del minuto. Termino la richiesta.`);
                const exhaustion = exhaustedRetryError(err, maxRetries, { attempts });
                hooks.onExhausted(exhaustion, { attempts, timedOut: false });
                traceAttempt("rate_limit", err);
                return;
              }
            }
          }
          if (smartConfig.rotateOnlyOnDailyQuota && isRateLimit && !isDailyExhausted) {
            console.warn(`[SmartFallback] Rotazione chiavi negata su 429 del minuto per proteggere le quote rimanenti.`);
            const exhaustion = exhaustedRetryError(err, maxRetries, { attempts });
            hooks.onExhausted(exhaustion, { attempts, timedOut: false });
            traceAttempt("rate_limit", err);
            return;
          }
          const exempt = recordRetryableFailure(route, err, hooks.state);
          const errStr = err?.message ?? "";
          if (budgetMs > 0 && typeof errStr === "string" && errStr.includes("in-band provider error") && Date.now() - attemptStartedAt >= budgetMs * HEDGE_BENCH_MIN_SILENT_FRACTION) {
            setCooldown(route.platform, route.modelId, route.keyId, TRUNCATION_BENCH_MS, "heuristic");
            console.warn(`[FallbackLoop] ${route.platform}/${route.modelId}: in-band provider error after ${((Date.now() - attemptStartedAt) / 1e3).toFixed(1)}s silent \u2014 benching the route ${Math.round(TRUNCATION_BENCH_MS / 1e3)}s (#1218 Gap 3)`);
          }
          const errorClass = classifyAttemptError(err);
          attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass });
          traceAttempt(errorClass, err);
          lastError = err;
          if (!exempt && stopIfBreakerTripped()) return;
          continue;
        }
        traceAttempt(classifyAttemptError(err), err);
        hooks.onFatal(route, err, attempt);
        return;
      }
      if (outcome !== "done" && outcome !== "committed") {
        const violation = new Error(
          `fallback-loop dispatch contract violation on ${route.platform}/${route.modelId}: expected 'done' or 'committed', got ${JSON.stringify(outcome)}`
        );
        console.error("[FallbackLoop]", violation.message);
        hooks.logFailure(route, violation, attempt);
        traceAttempt("error", violation);
        hooks.onFatal(route, violation, attempt);
        return;
      }
      traceAttempt(outcome === "done" ? "ok" : "committed");
      return;
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      route.release?.();
    }
  }
  hooks.onExhausted(
    exhaustedRetryError(lastError, maxRetries, { attempts }),
    { attempts, timedOut: false }
  );
}
export {
  AUTH_FAILURE_COOLDOWN_MS,
  DEFAULT_FALLBACK_TIME_BUDGET_MS,
  EMPTY_COMPLETION_STREAK_LIMIT,
  EXPOSE_FALLBACK_DETAIL_SETTING,
  FALLBACK_MAX_RETRIES,
  FALLBACK_TIME_BUDGET_SETTING,
  HEDGE_BENCH_MIN_SILENT_FRACTION,
  MODEL_FAILURE_COOLDOWN_MS,
  MODEL_FAILURE_THRESHOLD,
  MODEL_FAILURE_WINDOW_MS,
  MODEL_NOT_FOUND_PLATFORM_LIMIT,
  TRUNCATION_BENCH_MS,
  TRUNCATION_STREAK_LIMIT,
  classifyAttemptError,
  clearModelFailureWindows,
  cooldownDecisionForError,
  cooldownForError,
  exhaustedRetryError,
  exhaustionErrorPayload,
  fallbackRoutingTokens,
  formatAttemptDetail,
  formatAttemptTrail,
  getFallbackTimeBudgetMs,
  isFallbackDetailHeaderEnabled,
  msUntilNextPacificMidnight,
  msUntilNextUtcMidnight,
  newFallbackState,
  recordAuthFailure,
  recordRetryableFailure,
  recordUpstreamSuccess,
  resetEmptyCompletionStreaks,
  resetModelFailureWindows,
  resetTruncationStreaks,
  routingExhaustionBody,
  runFallbackLoop,
  setExhaustionHeaders,
  setFallbackHeaders
};
