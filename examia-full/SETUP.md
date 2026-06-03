# examIA — Guía de despliegue

App de exámenes tipo test con IA. **3 exámenes gratis** y luego **suscripción Pro mensual** (Stripe).
Con **login por enlace mágico** (email): la suscripción se guarda en la cuenta del usuario y
funciona en cualquier dispositivo.

## Archivos
```
index.html, app.js, vercel.json
api/_lib.js           helpers compartidos
api/generate.js       genera preguntas (gratis con límite / ilimitado si Pro)
api/extract.js        extrae texto del PDF
api/me.js             sesión actual + suscripción + exámenes gratis restantes
api/login-request.js  envía el enlace mágico por email
api/login-verify.js   canjea el enlace por una sesión
api/checkout.js       inicia el pago en Stripe (ligado al email del usuario)
```

## Paso 1 — Subir todo a GitHub (incluida la carpeta api/)

## Paso 2 — Redis (Upstash, gratis)
upstash.com → Create Database (Redis, Europe) → copia `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`

## Paso 3 — Email (Resend, gratis)
1. Crea cuenta en https://resend.com (gratis: 3.000 emails/mes)
2. **API Keys** → Create API Key → copia la clave (`re_...`) → será `RESEND_API_KEY`
3. **Remitente (MAIL_FROM):**
   - Para **probar ya**: usa `onboarding@resend.dev` (solo envía a TU propio email registrado en Resend)
   - Para **producción**: en Resend → Domains → añade tu dominio y verifica los DNS.
     Luego usa algo como `examIA <login@tudominio.com>`

## Paso 4 — Stripe (cobros)
1. stripe.com (modo test para empezar)
2. Catálogo de productos → producto "examIA Pro" → precio **recurrente mensual** (9€) → copia el **Price ID** (`price_...`)
3. Developers → API keys → copia la **Secret key** (`sk_test_...`)

## Paso 5 — Generar AUTH_SECRET
Una cadena aleatoria larga para firmar las sesiones. Genera una en:
https://generate-secret.vercel.app/64  (o cualquier texto aleatorio largo)

## Paso 6 — Variables de entorno en Vercel (Settings → Environment Variables)
| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `UPSTASH_REDIS_REST_URL` | de Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | de Upstash |
| `RESEND_API_KEY` | `re_...` de Resend |
| `MAIL_FROM` | `onboarding@resend.dev` (o tu dominio) |
| `AUTH_SECRET` | cadena aleatoria larga |
| `STRIPE_SECRET_KEY` | `sk_test_...` |
| `STRIPE_PRICE_ID` | `price_...` |

## Paso 7 — ⚠️ Tope de gasto en Anthropic
console.anthropic.com → Settings → Limits.
- Sin suscriptores: 15 USD/mes.
- Con suscriptores: súbelo (cada Pro te cuesta ~1-4€ de API pero te paga 9€).

## Cómo funciona
- **Login:** email → enlace mágico → sesión 30 días (sin contraseñas). Funciona en cualquier dispositivo.
- **Gratis:** 3 exámenes/mes por usuario (por email si ha iniciado sesión, si no por IP). Tope global 600/mes.
- **Pro (9€/mes):** ilimitado (cap interno 300/mes). La suscripción va ligada al email en Stripe,
  así que el usuario la conserva aunque cambie de dispositivo o borre el navegador. Solo tiene que iniciar sesión.

## Probar el flujo completo (modo test)
1. Abre la web → "Iniciar sesión" → tu email → abre el enlace del correo
2. Agota los 3 gratis → "Suscribirme"
3. Paga con tarjeta de test: `4242 4242 4242 4242`, fecha futura, CVC cualquiera
4. Al volver verás "✨ Plan Pro activo"
5. Prueba a entrar desde otro navegador: inicia sesión con el mismo email → sigues siendo Pro

## Ajustes (api/_lib.js)
- `PER_IP_LIMIT = 3`  exámenes gratis por usuario/mes
- `GLOBAL_CAP = 600`  tope de exámenes GRATIS/mes
- `SUB_CAP = 300`     tope mensual por suscriptor Pro
