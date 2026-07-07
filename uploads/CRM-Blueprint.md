# CRM Blueprint — Especificación completa para replicar la herramienta

Este documento describe la arquitectura, modelo de datos, módulos, flujos e integraciones del CRM existente. Está pensado para entregarse a otra herramienta de IA (Cursor, Bolt, v0, Claude Code, etc.) como prompt de partida. Adapta nombres de etapas, tipos de producto y campos a tu vertical (el CRM original es de seguros; los conceptos son genéricos).

---

## 1. Stack técnico recomendado

- **Frontend:** React 18 + Vite + TypeScript + TailwindCSS + shadcn/ui + React Router + TanStack Query.
- **Backend:** Supabase (Postgres + Auth + Storage + Edge Functions Deno) o equivalente (Postgres + PostgREST/Hasura + funciones serverless).
- **Auth:** Email/Password + Google OAuth. Roles vía tabla `user_roles` (nunca en `profiles`) con enum `app_role` (`admin`, `moderator`, `user`) y función `has_role(uuid, app_role)` SECURITY DEFINER.
- **RLS:** habilitada en todas las tablas de `public`, con `GRANT` explícitos a `authenticated`/`service_role`.
- **Estado UI:** TanStack Query para server state, contextos ligeros para filtros globales.
- **Envío emails:** Gmail API (service account con delegación) + Resend como fallback.
- **WhatsApp:** WhatsApp Cloud API (Meta) con webhook.
- **Push:** Web Push (VAPID).
- **Storage buckets:** `crm-documents` (público firmable), `client-documents` (privado), `email-assets` (público), `asset-images` (público).

---

## 2. Modelo de datos (tablas núcleo)

Todas las tablas llevan `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at` con trigger `update_updated_at_column`, y `deleted_at timestamptz` para soft delete cuando aplica.

### 2.1 `profiles`
Perfil de usuario logueado. FK a `auth.users(id)`.
Campos: `full_name`, `email`, `phone`, `avatar_url`, `dni_nie`, `address`, `city`, `postal_code`, preferencias de cookies.

### 2.2 `user_roles`
`(user_id uuid → auth.users, role app_role, unique(user_id, role))`.
Consulta con `has_role(auth.uid(), 'admin')`.

### 2.3 `crm_contacts`  — Contacto (persona/empresa)
Campos principales:
- Identidad: `full_name`, `email` (único vía índice `LOWER(email)`), `phone`, `dni_nie`.
- Dirección: `address`, `city`, `postal_code`, `province`, `region` (CCAA).
- Marketing: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`.
- CRM: `lifecycle_stage` (enum: `new` | `opportunity` | `quoted` | `active_customer` | `lost`), `assigned_to uuid` (owner), `source`, `priority`.
- Compliance: `kyc_verified bool`, `aml_risk_level`, `consent_data_processing`, `consent_marketing`.
- Flags: `is_registered_user bool` (true cuando existe profile con mismo email).
- `deleted_at` para papelera.

Índice único `LOWER(email) WHERE deleted_at IS NULL` para dedupe.

### 2.4 `crm_deals` — Oportunidad / Negocio
Un contacto puede tener N deals. Un deal representa una venta/servicio concreto.
Campos:
- FK: `contact_id`, `assigned_to`, `insured_asset_id` (link al "producto" del cliente cuando se firma).
- `title`, `deal_stage` (enum configurable), `policy_type` / `product_type`, `source`, `priority`.
- Datos comerciales: `current_insurer` (proveedor actual), `current_premium`, `insurer_name` (nuevo proveedor), `offered_premium`, `premium_amount`, `payment_frequency` (`mensual`|`trimestral`|`semestral`|`anual`).
- Fechas: `start_date`, `end_date`, `renewal_date`, `signed_at`.
- Cierre: `loss_reason` (enum), `loss_notes`.
- Datos flexibles: `quoting_data jsonb` (todo lo específico del vertical).
- UTMs replicadas del contacto en el momento de captación.
- `deleted_at`.

### 2.5 `crm_deal_stage_history`
Registra cada transición de etapa. Trigger `crm_record_deal_stage_change` inserta en `AFTER UPDATE` cuando cambia `deal_stage`.
Campos: `deal_id`, `from_stage`, `to_stage`, `changed_by`, `changed_at`.

### 2.6 `crm_tasks`
`title`, `description`, `status` (`pending`|`in_progress`|`done`|`cancelled`), `priority`, `due_date`, `assigned_to`, `contact_id`, `deal_id`, `created_by`.

### 2.7 `crm_notes`
Notas libres asociadas a contacto/deal. `body text`, `contact_id`, `deal_id`, `created_by`.

### 2.8 `crm_calls`
Registro de llamadas: `contact_id`, `deal_id`, `direction`, `outcome`, `duration_seconds`, `notes`, `called_at`, `user_id`.

### 2.9 `crm_emails` — Bandeja unificada
Sincronizada con Gmail. Campos: `message_id`, `thread_id`, `direction` (`inbound`|`outbound`), `from_email`, `to_emails[]`, `cc[]`, `subject`, `body_html`, `body_text`, `snippet`, `sent_at`, `received_at`, `contact_id`, `deal_id`, `has_attachments`, `labels[]`.

### 2.10 `crm_email_templates`
`name`, `subject`, `body_html`, `scope` (`contact`|`deal`|`both`), placeholders tipo `{{nombre}}`, `{{prima}}`.

### 2.11 `crm_email_labels` + `crm_email_label_assignments`
Etiquetado tipo Gmail.

### 2.12 `crm_email_unsubscribes` + `crm_email_suppressions`
Bloqueos y bounces. Función `is_email_blocked(email)` para validar antes de enviar.

### 2.13 `crm_campaigns` + `crm_campaign_recipients` + `crm_campaign_events`
Campañas de email masivo:
- Campaign: `name`, `subject`, `body_html`, `from_email`, `from_name`, `reply_to`, `status` (`draft`|`scheduled`|`sending`|`sent`|`paused`), `scheduled_at`, `list_id`, contadores agregados (sent/delivered/opened/clicked/bounced/unsubscribed), tracking flags.
- Recipient: `campaign_id`, `contact_id`, `email`, `status` (`pending`|`sending`|`sent`|`failed`|`bounced`), `claimed_at`, `sent_at`, `opened_at`, `clicked_at`, `error_message`.
- Event: `recipient_id`, `event_type` (`open`|`click`|`bounce`|`unsubscribe`), `url`, `user_agent`, `ip`, `occurred_at`.
- Función `claim_campaign_recipients(campaign_id, batch)` con `FOR UPDATE SKIP LOCKED` para envío por lotes desde edge function.
- Función `expire_stuck_campaign_recipients(minutes)` para desatascar.

### 2.14 `crm_lists` + `crm_list_members`
Listas de contactos, estáticas o dinámicas. `filters jsonb` para dinámicas (se resuelven en cliente/servidor).

### 2.15 `crm_documents`
Archivos vinculados a contact/deal/asset. `file_name`, `file_url` (Storage), `document_type`, `size_bytes`, `mime_type`, `uploaded_by`, `status`, visibilidad al cliente (`visible_to_client bool`).

### 2.16 `crm_complaints`
Reclamaciones/incidencias con estados y SLA.

### 2.17 `crm_automations` + `crm_trigger_stage_mappings` + `crm_system_automations`
Motor de reglas:
- `crm_automations`: reglas de negocio configurables (trigger, condiciones jsonb, acciones jsonb, enabled).
- `crm_trigger_stage_mappings`: mapea `deal_stage → lifecycle_stage` para el trigger `sync_contact_lifecycle_from_deal`.
- `crm_system_automations`: catálogo de triggers de sistema (nombre, schema, tabla, función) con `enable/disable` vía RPC SECURITY DEFINER.

### 2.18 `insured_assets` (o `products`)
Producto/bien del cliente ya contratado. Se materializa desde un deal al pasar a `signed`.
Campos: `user_id`, `asset_type` (`car`|`home`|`person`|`pet`|…), `display_name`, `status`, `current_insurer`, `current_policy_number`, `current_premium_amount`, `current_payment_frequency`, `current_policy_start_date`, `renewal_date`, `current_coverage_type`, imagen.

Tablas hijas por tipo con detalles específicos (`car_details`, `home_details`, `person_details`, `pet_details`, `motorbike_details`).

### 2.19 `crm_dashboards` + `crm_dashboard_widgets`
Dashboards personalizables por usuario.

### 2.20 `whatsapp_conversations` + `whatsapp_messages` + `whatsapp_templates`
Chat WhatsApp integrado.

### 2.21 `push_subscriptions`
Suscripciones Web Push por usuario/dispositivo.

---

## 3. Enums / catálogos configurables

Guárdalos en constantes TS (`crm-utils.ts`) o en tabla `crm_config`:

```ts
LIFECYCLE_STAGES = ['new','opportunity','quoted','active_customer','lost']
DEAL_STAGES = [
  'new_request','contacted','quoted','precontract_sent',
  'policy_signed','renewal_pending','renewal_offer_sent',
  'policy_inactive','lost'
]
PRIORITIES = ['high','medium','low']
LOSS_REASONS = ['no_contesta','no_interesado','precio_alto','contratado_otra',...]
```

Cada etapa tiene: `id`, `label`, `phase` (agrupación), `color`.

---

## 4. Triggers y funciones de base de datos clave

1. **`handle_new_user`** (AFTER INSERT en `auth.users`) → crea `profiles`, materializa deals firmados que coincidan por email.
2. **`sync_contact_to_crm`** (AFTER INSERT en `contacts` públicos, formulario web) → upsert en `crm_contacts` por email + crea `crm_deals` con UTMs.
3. **`crm_record_deal_stage_change`** → alimenta `crm_deal_stage_history`.
4. **`sync_contact_lifecycle_from_deal`** → sube lifecycle al pasar deal a nuevas fases (usa `crm_trigger_stage_mappings`, con ranking para no retroceder salvo `lost`).
5. **`materialize_asset_on_policy_signed`** (BEFORE UPDATE) → cuando `deal_stage='policy_signed'` y hay usuario registrado con ese email, crea/reutiliza `insured_assets` y linkea `deal.insured_asset_id`.
6. **`sync_asset_to_crm_deal` / `sync_crm_deal_to_asset`** → bidireccional entre asset y deal.
7. **`cascade_contact_soft_delete_to_deals` / `cascade_contact_hard_delete_to_deals`**.
8. **`mark_crm_contact_registered`** (AFTER INSERT en `profiles`) → marca `is_registered_user=true`.
9. **`is_email_blocked(email)`** → check antes de enviar.
10. **`expire_travel_policies` / `expire_stuck_campaign_recipients`** → limpieza programada (cron).
11. **`get_crm_contact_id_for_user()`** → devuelve el contact_id del usuario autenticado (para portal cliente).
12. **`enable_system_automation / disable_system_automation`** → crean/destruyen triggers en runtime.

Todas SECURITY DEFINER con `SET search_path = public` y validación de rol donde toca.

---

## 5. RLS (patrón)

Para tablas CRM (admin-only):
```sql
CREATE POLICY "admins_moderators_all" ON public.crm_deals
FOR ALL TO authenticated
USING (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'moderator'))
WITH CHECK (has_role(auth.uid(),'admin') OR has_role(auth.uid(),'moderator'));
```

Para tablas del portal cliente (`insured_assets`, `crm_documents` visibles):
```sql
USING (user_id = auth.uid() OR has_role(auth.uid(),'admin'))
```

`user_roles`: SELECT propio + admin gestiona todo.

---

## 6. Estructura de rutas frontend

```
/                              Landing pública
/login, /registro, /reset      Auth
/area-cliente                  Portal cliente (lista de assets, docs, mensajes)
/area-cliente/nuevo/:type
/area-cliente/:id              Detalle asset + solicitar renovación

/admin/login
/admin/dashboard               KPIs ejecutivos (ver §9)
/admin/crm/contacts            Tabla + filtros + import + bulk
/admin/crm/contacts/:id        Ficha contacto (tabs: Overview, Deals, Notes, Tasks, Emails, Calls, WhatsApp, Documents, Activity)
/admin/crm/pipeline            Kanban por deal_stage (drag & drop) + tabla
/admin/crm/deals/:id           Ficha deal unificada
/admin/crm/tasks               Lista tareas
/admin/crm/inbox               Bandeja email centralizada (Gmail-like)
/admin/crm/campaigns           Lista + builder
/admin/crm/campaigns/new
/admin/crm/lists               Listas dinámicas/estáticas
/admin/crm/email-templates
/admin/crm/whatsapp            Chat
/admin/crm/automations         Reglas
/admin/crm/dashboard           Dashboards personalizables
/admin/configuracion           Roles, aseguradoras, catálogos, dominios email
```

---

## 7. Módulos funcionales (detalle)

### 7.1 Contactos
- Vista tabla con columnas configurables, filtros (lifecycle, owner, ciudad, UTMs, fecha), búsqueda full-text.
- Selección múltiple → **bulk actions**: cambiar owner, añadir a lista, cambiar lifecycle, exportar CSV, papelera.
- **Dedupe por LOWER(email)**; al crear con email existente se propone fusionar.
- **Import Excel/CSV** con mapeo de columnas, preview, validación y creación de deal opcional.
- **Papelera** (soft delete `deleted_at`) con restaurar/eliminar definitivo.

### 7.2 Deals / Pipeline
- **Kanban** por `deal_stage` con drag & drop (limitado a fases permitidas por reglas).
- Al mover a `lost` → popup obligatorio con `loss_reason` + notas; propaga a deals relacionados si aplica.
- Al mover a `policy_signed` → si el contacto es usuario registrado, materializa `insured_asset`.
- **Ficha deal** con secciones: datos, cotización (dinámica según `policy_type` — usa `quoting_data jsonb`), documentos, actividad (emails, llamadas, notas, tareas, WhatsApp, historial de etapas).
- **Creación manual** de deal al crear contacto (opcional).
- Auto-cálculo `end_date` y `renewal_date` según `payment_frequency` y `start_date`.

### 7.3 Bandeja de emails (Inbox)
- Sincronización bidireccional Gmail via `gmail-sync` edge function (cron cada N min + polling manual).
- Vista tipo Gmail: lista de conversaciones (thread) + panel de lectura + composer.
- **Vinculación automática** email ↔ contact/deal por `from/to`.
- Composer rich text con adjuntos, plantillas, placeholders resueltos con datos del contact/deal.
- Etiquetas propias + estrellas + snooze.

### 7.4 Plantillas de email
- Editor rich text con variables `{{nombre}}`, `{{compania}}`, `{{prima_actual}}`, etc.
- Scope: `contact`, `deal`, `both`.

### 7.5 Campañas
- **Builder por bloques** (drag & drop): heading, texto, imagen, botón, columnas, divider, spacer.
- Preview desktop/mobile.
- Destinatarios: lista o filtro dinámico.
- Envío por lotes desde edge function `send-campaign` con `claim_campaign_recipients` (FOR UPDATE SKIP LOCKED) para paralelizar.
- Tracking: pixel `track-open`, redirect `track-click`, `unsubscribe` con token.
- Métricas en tiempo real: enviados, entregados, abiertos, clicados, bounces, bajas.
- Respeta `crm_email_unsubscribes` y `crm_email_suppressions`.

### 7.6 Listas
- Estáticas: `crm_list_members`.
- Dinámicas: `filters jsonb` con operadores AND/OR sobre campos de contacto/deal (incluye estados virtuales tipo "sin actividad 30d").

### 7.7 Tareas
- Lista propia + widget en dashboard + notificación push cuando vence.
- Vinculación opcional a contact/deal.

### 7.8 WhatsApp
- Chat integrado con Cloud API. Webhook `whatsapp-webhook` procesa mensajes entrantes y estados.
- Envío desde `whatsapp-send` (texto y plantillas aprobadas).
- Sincronización de plantillas: `whatsapp-templates-sync`.
- Vinculación por número de teléfono a contact/deal.

### 7.9 Documentos
- Upload a Storage privado, URL firmada bajo demanda.
- `visible_to_client bool` → aparece en portal cliente con notificación email al compartir.

### 7.10 Automatizaciones
- Motor de reglas configurable en UI:
  - **Trigger:** `deal_stage_changed`, `contact_created`, `renewal_in_X_days`, `no_activity_X_days`, `email_opened`, etc.
  - **Condiciones:** JSON logic sobre campos.
  - **Acciones:** crear tarea, enviar email/plantilla, cambiar owner, cambiar lifecycle, notificar push, webhook.
- Además, catálogo de **automations de sistema** (triggers DB) que se pueden encender/apagar desde UI vía RPC.

### 7.11 Dashboards
- Página `/admin/dashboard` con filtros globales (rango, admin, tipo, proveedor) y secciones:
  1. **KPIs** (10 tarjetas con Δ% vs periodo anterior + sparkline).
  2. **Funnel** de conversión (tiempo medio por etapa + tasas + motivos de pérdida).
  3. **Comercial** (leads por tipo, distribución por etapa, firmados por proveedor, ranking de administradores, ahorros).
  4. **Mapa geográfico** (coroplético por región, top ciudades/provincias).
  5. **Cartera / renovaciones** (buckets 30/60/90 días, ARR por tipo/proveedor, retención).
  6. **Marketing** (leads por UTM, tabla de campañas UTM, tendencia de canales).
  7. **Compliance** (KYC, consents, AML, datos incompletos).
- Export CSV (papaparse) + PDF (html2canvas + jsPDF).
- Click en widget → navega al listado filtrado (deep-linking por querystring).

### 7.12 Portal cliente
- Lista de `insured_assets` con tarjetas por tipo.
- Detalle con datos, documentos compartidos por el asesor, botón "Solicitar renovación" que crea un deal `new_request`.
- Notificaciones push (VAPID) para novedades.

---

## 8. Edge functions (Deno)

Con CORS estándar, JWT check manual, validación con Zod:

- `gmail-sync` — pull incremental de Gmail vía service account, upsert en `crm_emails`.
- `send-campaign` — envío por lotes usando `claim_campaign_recipients`.
- `track-open` — pixel 1x1 que registra `crm_campaign_events`.
- `track-click` — redirect que registra click y devuelve 302.
- `unsubscribe` — token firmado, inserta en `crm_email_unsubscribes`.
- `whatsapp-webhook` — verify token + procesa mensajes.
- `whatsapp-send`, `whatsapp-templates-sync`.
- `facebook-leads` — webhook Zapier/Meta para leads.
- `extract-policy-data` — OCR de PDF de póliza (LLM) → rellena `quoting_data`.
- `ai-email-assistant` — sugerencias de respuesta con LLM.
- `ai-generate-image` — imágenes para campañas/blog.
- `send-push` — Web Push a `push_subscriptions`.
- `og-meta` — SEO metadata dinámica.

---

## 9. Integraciones externas

- **Gmail API** (service account + domain-wide delegation).
- **Resend** (fallback transaccional).
- **WhatsApp Cloud API** (Meta).
- **Facebook Lead Ads** (webhook).
- **HubSpot** (opcional, mirror de leads).
- **Zapier** (webhooks entrantes/salientes).
- **LLM Gateway** (OpenAI/Anthropic/Gemini) para IA de emails y extracción de documentos.
- **Google Analytics / GTM** (cargados tras consentimiento cookies).

---

## 10. Seguridad — reglas duras

1. Roles SOLO en `user_roles`, nunca en `profiles`. Chequeo con `has_role()` SECURITY DEFINER.
2. RLS ON en todas las tablas de `public` + GRANT explícitos.
3. Sin sign-up anónimo, sin auto-confirm salvo instrucción explícita.
4. Nunca ejecutar SQL crudo desde cliente ni exponer `service_role`.
5. Validar todo input de edge function con Zod y devolver 400 con errores.
6. `unsubscribe` con token HMAC firmado, no ID directo.
7. Documentos privados en bucket privado + signed URL con TTL corto.
8. Rate-limit en composer de email y en campañas (respetar `is_email_blocked`).

---

## 11. UX y design system

- Sidebar admin oscura + fondo claro + color primario a elegir (tokens semánticos en `index.css`, nunca hex hardcodeado en componentes).
- shadcn/ui como base.
- Skeletons + estados vacíos con icono y CTA.
- Grid responsive 1→2→4 columnas para KPIs.
- Toaster global para feedback.
- Papelera universal con "Restaurar / Eliminar definitivamente".

---

## 12. Orden de implementación sugerido

1. Auth + roles + RLS base + `profiles` + `user_roles`.
2. `crm_contacts` (CRUD, tabla, filtros, papelera, dedupe, import).
3. `crm_deals` + pipeline kanban + historial de etapas + motivos de pérdida.
4. Notas + tareas + llamadas + documentos.
5. Bandeja de emails + templates + Gmail sync.
6. WhatsApp.
7. Campañas + listas + tracking + unsubscribe.
8. Automatizaciones (reglas + system).
9. Dashboards + export.
10. Portal cliente + push + documentos compartidos.
11. IA (extract-policy-data, ai-email-assistant).

---

## 13. Prompt de arranque para la nueva herramienta

> Construye un CRM completo con la siguiente arquitectura y funcionalidad (ver secciones 1–12 de este documento). Usa React + TypeScript + Tailwind + shadcn en frontend y Postgres con RLS + funciones/edge functions en backend. Implementa modelo de datos, triggers, RLS y funciones descritos en §2–§5. Empieza por §12 paso 1 y confirma cada hito antes de continuar. Antes de crear cada tabla en `public`, asegúrate de añadir GRANTs explícitos y política RLS. No inventes campos: si falta información pregunta. Adapta los enums `LIFECYCLE_STAGES`, `DEAL_STAGES`, `LOSS_REASONS` y los tipos de producto (`policy_type`) a mi vertical, que te confirmaré antes de arrancar.

Fin del blueprint.
