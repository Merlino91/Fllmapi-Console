# FLLMAPI Console & Fallback Controller ⚡

Console di controllo Web, monitoraggio SQLite e motore di **Smart Fallback** per [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi).

---

## 🎯 Perché nasce questo progetto?

Di serie, FreeLLMAPI esegue un fallback aggressivo: non appena un provider restituisce un errore temporaneo `429 Too Many Requests` (es. limite di richieste al minuto RPM), il proxy banna subito la chiave e salta alla chiave o al modello successivo.
Questo comportamento ha due gravi difetti:
1. **Distrugge il Prompt Caching:** La nuova chiave o il nuovo modello non hanno in cache il contesto precedente, provocando una ri-elaborazione completa di tutti i token e saturando immediatamente i limiti TPM.
2. **Rimbalzo su modelli inferiori:** Se una richiesta fallisce, rischia di far subentrare modelli più piccoli o stupidi che possono rovinare task delicati (come la generazione di codice).

**FLLMAPI Console** risolve questi problemi introducendo:
- ⏱️ **In-Place Wait & Retry (RPM):** Estrae i secondi di attesa indicati dal provider (`retryAfterMs`) e, se l'attesa è breve (es. $\le 15$s), attende ed esegue un nuovo tentativo sulla **stessa identica chiave**, preservando al 100% la cache del prompt.
- 🔒 **Strict Single-Provider Lock:** Impedisce al router di scivolare su modelli o provider alternativi indesiderati quando una chiave si esaurisce.
- 🗜️ **Compressione Fallback su TPM (413):** Compatta dinamicamente il contesto della richiesta se si sfora la finestra di contesto.
- 📊 **Dashboard Web in Tempo Reale:** Monitora chiavi in cooldown con conto alla rovescia in secondi e registro dei tentativi recenti direttamente dal database SQLite.

---

## 🚀 Architettura Docker & Dokploy

```
┌────────────────────────────────────────────────────────┐
│                   DOKPLOY / DOCKER                     │
│                                                        │
│  ┌──────────────────────────┐   ┌───────────────────┐  │
│  │        FreeLLMAPI        │   │  FLLMAPI Console  │  │
│  │   (Proxy Inferenza)      │   │   (Web Dashboard) │  │
│  │       Porta 3001         │   │     Porta 3002    │  │
│  └─────────────┬────────────┘   └─────────┬─────────┘  │
│                │                          │            │
│                │  Volume: freellmapi_cfg  │            │
│                ├──────────────────────────┤            │
│                │  [fallback-config.json]  │            │
│                │ (Modifiche lette al volo)│            │
│                │                          │            │
│                │  Volume: freellmapi_data │            │
│                ├──────────────────────────┘            │
│                ▼                                       │
│       [freellmapi.db (Read-Only)]                      │
│       (Log & Cooldown in tempo reale)                  │
└────────────────────────────────────────────────────────┘
```

---

## 🛠️ Come Pubblicare su GitHub

Per salvare questo progetto nel tuo account GitHub:

1. Crea un nuovo repository vuoto su [GitHub](https://github.com/new) chiamato ad esempio `fllmapi-console` (pubblico o privato).
2. Apri il terminale all'interno di questa cartella (`C:\Antigravity\FLLMAPI Console`) ed esegui:

```bash
git init
git add .
git commit -m "feat: initial commit FLLMAPI Console"
git branch -M main
git remote add origin https://github.com/TUO-UTENTE/fllmapi-console.git
git push -u origin main
```

---

## 📦 Configurazione Docker Compose per Dokploy

Nel tuo stack **Compose** su Dokploy, usa questa configurazione:

```yaml
services:
  # 1. FreeLLMAPI (Proxy Ufficiale)
  freellmapi:
    image: ghcr.io/tashfeenahmed/freellmapi:latest
    container_name: freellmapi
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3001
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - FREELLMAPI_INSTALL_METHOD=docker
      - TRUST_PROXY=true
      - FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true
      - PROXY_RATE_LIMIT_RPM=0
      - REQUEST_BODY_LIMIT_MB=50
      - IMAGE_NORMALIZE=on
      - FREELLMAPI_COMPRESSION=lossless
      - FALLBACK_CONFIG_PATH=/config/fallback-config.json
    volumes:
      - freellmapi-data:/app/server/data
      - freellmapi-config:/config
    networks:
      - dokploy-network
    extra_hosts:
      - "host.docker.internal:host-gateway"

  # 2. FLLMAPI Console (Costruito direttamente dal tuo GitHub)
  freellmapi-console:
    build:
      context: https://github.com/TUO-UTENTE/fllmapi-console.git#main
    container_name: freellmapi-console
    restart: unless-stopped
    environment:
      - PORT=3002
      - FALLBACK_CONFIG_PATH=/config/fallback-config.json
      - DB_PATH=/app/server/data/freellmapi.db
    volumes:
      - freellmapi-config:/config
      - freellmapi-data:/app/server/data:ro
    networks:
      - dokploy-network

volumes:
  freellmapi-data:
    name: freellmapi_data
  freellmapi-config:
    name: freellmapi_config

networks:
  dokploy-network:
    external: true
```

---

## 🌐 Mappatura Domini su Dokploy

- **API FreeLLMAPI:** `api.tuodominio.com` $\rightarrow$ Service: `freellmapi`, Porta: `3001`
- **Dashboard Console:** `console.tuodominio.com` $\rightarrow$ Service: `freellmapi-console`, Porta: `3002`

---

## 📄 Licenza

Rilasciato sotto licenza [MIT](LICENSE).
