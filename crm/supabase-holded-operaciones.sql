-- ============================================================
-- GUIMAES — Holded, operaciones genéricas con aprobación humana
--
-- Encima de crm/supabase-holded-acciones.sql (20261127180000):
--   * holded_operaciones: la LISTA CERRADA de operaciones de escritura de la
--     API v2 (generada desde la especificación oficial por
--     crm/tests/holded/generar-catalogo.py), con su riesgo (normal | alto).
--   * holded_acciones: nuevo tipo «operacion» (operación del catálogo, riesgo
--     y descripción legible). «aprobar_tickets_venta» sigue igual.
--   * holded_acciones_items: la cola admite peticiones (método, ruta,
--     cuerpo, estado anterior del documento, id que devuelve Holded) y el
--     estado «desconocido» (un POST sin respuesta: no se reintenta solo).
--     La clave pasa a (accion_id, orden).
--   * Aprobar: las de riesgo alto exigen escribir CONFIRMAR (solo rol admin,
--     como todo). Las políticas automáticas no pueden ser de riesgo alto.
--   * Cupo de acciones: 50 al mes por defecto; las empresas con 0 pasan a 50.
--   * Retención: 90 días después de terminar (completada, cancelada o
--     rechazada; o caducada sin aprobar) se borran el cuerpo y el estado
--     anterior: quedan método, ruta, resultado e id de Holded. pg_cron diario.
--
-- Migración 20261127230000. Ejecutar en orden 9A → 9B → 9C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/holded).
-- ============================================================


-- ============================================================
-- 9A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127180000: sí    migración 20261127230000: no
--   tabla holded_operaciones: 0     acciones de tipo operacion: 0
--   tarea holded-acciones-purgar: 0
--   cupos (0 / >0): (anotar)        items: (anotar)
-- ============================================================
select 'migración 20261127180000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127180000') then 'sí' else 'no' end as valor
union all
select 'migración 20261127230000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127230000') then 'sí' else 'no' end
union all
select 'tabla holded_operaciones', count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'holded_operaciones'
union all
select 'acciones de tipo operacion', count(*)::text from public.holded_acciones where tipo <> 'aprobar_tickets_venta'
union all
select 'tarea holded-acciones-purgar', count(*)::text from cron.job where jobname = 'holded-acciones-purgar'
union all
select 'cupos (0 / >0)', (select count(*) from public.holded_conexiones where cupo_acciones_mensual = 0)::text || ' / ' ||
                         (select count(*) from public.holded_conexiones where cupo_acciones_mensual > 0)::text
union all
select 'items', count(*)::text from public.holded_acciones_items;


-- ============================================================
-- 9B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
declare v_c text;
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127230000') then
    raise exception 'La migración 20261127230000 ya está aplicada';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261127180000') then
    raise exception 'Falta la migración 20261127180000 (acciones)';
  end if;

  -- ===================== catálogo (lista cerrada) =====================
  create table public.holded_operaciones (
    id       text primary key check (id ~ '^[A-Za-z0-9_]{1,80}$'),
    metodo   text not null check (metodo in ('POST', 'PUT', 'PATCH', 'DELETE')),
    ruta     text not null check (ruta ~ '^/[A-Za-z0-9/{}_-]+$'),
    tema     text not null,
    resumen  text not null,
    riesgo   text not null check (riesgo in ('normal', 'alto')),
    unique (metodo, ruta)
  );
  comment on table public.holded_operaciones is
    'Lista cerrada de escrituras de la API v2 de Holded (crm/tests/holded/generar-catalogo.py).';
  alter table public.holded_operaciones enable row level security;
  create policy "rol admin ve el catálogo" on public.holded_operaciones
    for select to authenticated using ((select public.is_admin_role()));
  revoke all on public.holded_operaciones from anon, authenticated;
  grant select on public.holded_operaciones to authenticated;

    -- <catalogo> (generado por crm/tests/holded/generar-catalogo.py el 2026-11-27 desde https://api.holded.com/openapi/es.json; no editar a mano)
    insert into public.holded_operaciones (id, metodo, ruta, tema, resumen, riesgo) values
      ('inviteAccountUser', 'POST', '/account/users', 'Cuenta', 'Invitar a un usuario a la cuenta', 'alto'),
      ('delete_account_user_invitation', 'DELETE', '/account/users/invitations/{invitationId}', 'Cuenta', 'Revocar invitación de usuario', 'alto'),
      ('update_account_user', 'PUT', '/account/users/{userId}', 'Cuenta', 'Actualizar rol de usuario', 'alto'),
      ('delete_account_user', 'DELETE', '/account/users/{userId}', 'Cuenta', 'Eliminar usuario de la cuenta', 'alto'),
      ('create_accounting_account', 'POST', '/accounting-accounts', 'Contabilidad', 'Crear una cuenta contable', 'alto'),
      ('create_booking', 'POST', '/bookings', 'Reservas', 'Crear una reserva', 'normal'),
      ('update_booking', 'PUT', '/bookings/{bookingId}', 'Reservas', 'Actualizar una reserva', 'normal'),
      ('delete_booking', 'DELETE', '/bookings/{bookingId}', 'Reservas', 'Borrar una reserva', 'alto'),
      ('create_contact_group', 'POST', '/contact-groups', 'Grupos de contactos', 'Crear un grupo de contactos', 'normal'),
      ('update_contact_group', 'PUT', '/contact-groups/{contactGroupId}', 'Grupos de contactos', 'Actualizar un grupo de contactos', 'normal'),
      ('delete_contact_group', 'DELETE', '/contact-groups/{contactGroupId}', 'Grupos de contactos', 'Borrar un grupo de contactos', 'alto'),
      ('create_contact', 'POST', '/contacts', 'Contactos', 'Crear un contacto', 'normal'),
      ('bulk_archive_contacts', 'POST', '/contacts/bulk-archive', 'Contactos', 'Archivar contactos en bloque', 'alto'),
      ('bulk_delete_contacts', 'POST', '/contacts/bulk-delete', 'Contactos', 'Borrar contactos en bloque', 'alto'),
      ('update_contact', 'PUT', '/contacts/{contactId}', 'Contactos', 'Actualizar un contacto', 'normal'),
      ('delete_contact', 'DELETE', '/contacts/{contactId}', 'Contactos', 'Borrar un contacto', 'alto'),
      ('patch_contact', 'PATCH', '/contacts/{contactId}', 'Contactos', 'Actualizar algunos campos de un contacto', 'normal'),
      ('create_contact_shipping_address', 'POST', '/contacts/{contactId}/shipping-addresses', 'Contactos', 'Crear una dirección de envío de un contacto', 'normal'),
      ('update_contact_shipping_address', 'PUT', '/contacts/{contactId}/shipping-addresses/{shippingId}', 'Contactos', 'Actualizar una dirección de envío de un contacto', 'normal'),
      ('delete_contact_shipping_address', 'DELETE', '/contacts/{contactId}/shipping-addresses/{shippingId}', 'Contactos', 'Eliminar una dirección de envío de un contacto', 'alto'),
      ('create_credit_note', 'POST', '/credit-notes', 'Facturas rectificativas', 'Crear una factura rectificativa (abono)', 'normal'),
      ('update_credit_note', 'PUT', '/credit-notes/{creditNoteId}', 'Facturas rectificativas', 'Actualizar una factura rectificativa (abono)', 'normal'),
      ('delete_credit_note', 'DELETE', '/credit-notes/{creditNoteId}', 'Facturas rectificativas', 'Borrar una factura rectificativa (abono)', 'alto'),
      ('approve_credit_note', 'POST', '/credit-notes/{creditNoteId}/approve', 'Facturas rectificativas', 'Aprobar una factura rectificativa', 'alto'),
      ('create_credit_note_payment', 'POST', '/credit-notes/{creditNoteId}/payments', 'Facturas rectificativas', 'Registrar un pago de factura rectificativa', 'alto'),
      ('set_credit_note_pipeline', 'PUT', '/credit-notes/{creditNoteId}/pipeline', 'Facturas rectificativas', 'Cambiar la fase de una factura rectificativa o abono (mover de etapa o estado, pipeline)', 'normal'),
      ('send_credit_note', 'POST', '/credit-notes/{creditNoteId}/send', 'Facturas rectificativas', 'Enviar factura rectificativa (abono) por email', 'alto'),
      ('create_crm_deal', 'POST', '/crm/deals', 'Oportunidades v2', 'Crear una oportunidad del CRM', 'normal'),
      ('delete_crm_deal', 'DELETE', '/crm/deals/{dealId}', 'Oportunidades v2', 'Borrar una oportunidad del CRM', 'alto'),
      ('update_crm_deal', 'PATCH', '/crm/deals/{dealId}', 'Oportunidades v2', 'Actualizar una oportunidad del CRM', 'normal'),
      ('lose_crm_deal', 'POST', '/crm/deals/{dealId}/lose', 'Oportunidades v2', 'Marcar una oportunidad del CRM como perdida', 'normal'),
      ('move_crm_deal_to_stage', 'POST', '/crm/deals/{dealId}/move', 'Oportunidades v2', 'Mover una oportunidad del CRM a una etapa', 'normal'),
      ('reopen_crm_deal', 'POST', '/crm/deals/{dealId}/reopen', 'Oportunidades v2', 'Reabrir una oportunidad del CRM', 'normal'),
      ('win_crm_deal', 'POST', '/crm/deals/{dealId}/win', 'Oportunidades v2', 'Marcar una oportunidad del CRM como ganada', 'normal'),
      ('create_crm_funnel', 'POST', '/crm/funnels', 'Embudos v2', 'Crear un embudo del CRM', 'normal'),
      ('delete_crm_funnel', 'DELETE', '/crm/funnels/{funnelId}', 'Embudos v2', 'Borrar un embudo del CRM', 'alto'),
      ('update_crm_funnel', 'PATCH', '/crm/funnels/{funnelId}', 'Embudos v2', 'Actualizar un embudo del CRM', 'normal'),
      ('convert_document', 'POST', '/documents/convert', 'Documentos', 'Convertir un documento a otro tipo', 'alto'),
      ('update_employee_time', 'PUT', '/employee-times/{timeId}', 'Control horario de empleados', 'Actualizar un registro de tiempo de empleado (parte de horas, jornada)', 'normal'),
      ('delete_employee_time', 'DELETE', '/employee-times/{timeId}', 'Control horario de empleados', 'Borrar un registro de tiempo de empleado (parte de horas, jornada)', 'alto'),
      ('create_employee', 'POST', '/employees', 'Empleados', 'Crear un empleado', 'normal'),
      ('update_employee', 'PUT', '/employees/{employeeId}', 'Empleados', 'Actualizar un empleado', 'normal'),
      ('delete_employee', 'DELETE', '/employees/{employeeId}', 'Empleados', 'Borrar un empleado', 'alto'),
      ('clock_in', 'POST', '/employees/{employeeId}/clock-in', 'Control horario de empleados', 'Fichar entrada de un empleado', 'normal'),
      ('clock_out', 'POST', '/employees/{employeeId}/clock-out', 'Control horario de empleados', 'Fichar salida de un empleado', 'normal'),
      ('update_employee_contract', 'PUT', '/employees/{employeeId}/contract', 'Empleados', 'Actualizar el contrato activo de un empleado', 'normal'),
      ('pause', 'POST', '/employees/{employeeId}/pause', 'Control horario de empleados', 'Iniciar pausa de un empleado', 'normal'),
      ('create_time_off', 'POST', '/employees/{employeeId}/time-offs', 'Ausencias y vacaciones', 'Solicitar una ausencia', 'normal'),
      ('update_time_off', 'PUT', '/employees/{employeeId}/time-offs/{timeOffId}', 'Ausencias y vacaciones', 'Actualizar una ausencia', 'normal'),
      ('create_employee_time', 'POST', '/employees/{employeeId}/times', 'Control horario de empleados', 'Crear un registro de tiempo para un empleado (parte de horas, jornada)', 'normal'),
      ('unpause', 'POST', '/employees/{employeeId}/unpause', 'Control horario de empleados', 'Finalizar pausa de un empleado', 'normal'),
      ('create_estimate', 'POST', '/estimates', 'Presupuestos', 'Crear un presupuesto', 'normal'),
      ('update_estimate', 'PUT', '/estimates/{estimateId}', 'Presupuestos', 'Actualizar un presupuesto', 'normal'),
      ('delete_estimate', 'DELETE', '/estimates/{estimateId}', 'Presupuestos', 'Borrar un presupuesto', 'alto'),
      ('accept_estimate', 'POST', '/estimates/{estimateId}/accept', 'Presupuestos', 'Aceptar un presupuesto', 'normal'),
      ('approve_estimate', 'POST', '/estimates/{estimateId}/approve', 'Presupuestos', 'Aprobar un presupuesto', 'alto'),
      ('set_estimate_pipeline', 'PUT', '/estimates/{estimateId}/pipeline', 'Presupuestos', 'Cambiar la fase de presupuesto (mover de etapa o estado, pipeline)', 'normal'),
      ('reject_estimate', 'POST', '/estimates/{estimateId}/reject', 'Presupuestos', 'Rechazar un presupuesto', 'normal'),
      ('send_estimate', 'POST', '/estimates/{estimateId}/send', 'Presupuestos', 'Enviar presupuesto por email', 'alto'),
      ('create_event', 'POST', '/events', 'Eventos', 'Crear un evento', 'normal'),
      ('update_event', 'PUT', '/events/{eventId}', 'Eventos', 'Actualizar un evento', 'normal'),
      ('delete_event', 'DELETE', '/events/{eventId}', 'Eventos', 'Borrar un evento', 'alto'),
      ('create_expenses_account', 'POST', '/expenses-accounts', 'Cuentas de gastos', 'Crear una cuenta de gastos', 'alto'),
      ('update_expenses_account', 'PUT', '/expenses-accounts/{expensesAccountId}', 'Cuentas de gastos', 'Actualizar una cuenta de gastos', 'alto'),
      ('delete_expenses_account', 'DELETE', '/expenses-accounts/{expensesAccountId}', 'Cuentas de gastos', 'Borrar una cuenta de gastos', 'alto'),
      ('create_funnel', 'POST', '/funnels', 'Embudos', 'Crear un embudo', 'normal'),
      ('update_funnel', 'PUT', '/funnels/{funnelId}', 'Embudos', 'Actualizar un embudo', 'normal'),
      ('delete_funnel', 'DELETE', '/funnels/{funnelId}', 'Embudos', 'Borrar un embudo', 'alto'),
      ('update_inbox', 'PUT', '/inbox/{incomingDocumentId}', 'Bandeja de entrada', 'Actualizar un documento entrante', 'normal'),
      ('delete_inbox', 'DELETE', '/inbox/{incomingDocumentId}', 'Bandeja de entrada', 'Borrar un documento entrante', 'alto'),
      ('attach_inbox', 'POST', '/inbox/{incomingDocumentId}/attach', 'Bandeja de entrada', 'Adjuntar documento entrante a un documento contable', 'normal'),
      ('export_inbox', 'POST', '/inbox/{incomingDocumentId}/export', 'Bandeja de entrada', 'Convertir documento entrante en documento de compra', 'alto'),
      ('create_invoice', 'POST', '/invoices', 'Facturas', 'Crear una factura', 'normal'),
      ('bulk_delete_invoices', 'DELETE', '/invoices', 'Facturas', 'Borrar facturas en lote', 'alto'),
      ('bulk_approve_invoices', 'POST', '/invoices/bulk/approve', 'Facturas', 'Aprobar facturas en lote: todas las pendientes de aprobar o una selección', 'alto'),
      ('bulk_cancel_invoices', 'POST', '/invoices/bulk/cancel', 'Facturas', 'Cancelar facturas en bloque', 'alto'),
      ('update_invoice', 'PUT', '/invoices/{invoiceId}', 'Facturas', 'Actualizar una factura', 'normal'),
      ('delete_invoice', 'DELETE', '/invoices/{invoiceId}', 'Facturas', 'Borrar una factura', 'alto'),
      ('approve_invoice', 'POST', '/invoices/{invoiceId}/approve', 'Facturas', 'Aprobar una factura', 'alto'),
      ('cancel_invoice', 'POST', '/invoices/{invoiceId}/cancel', 'Facturas', 'Cancelar una factura', 'alto'),
      ('create_invoice_payment', 'POST', '/invoices/{invoiceId}/payments', 'Facturas', 'Registrar un pago de factura', 'alto'),
      ('set_invoice_pipeline', 'PUT', '/invoices/{invoiceId}/pipeline', 'Facturas', 'Cambiar la fase de factura (mover de etapa o estado, pipeline)', 'normal'),
      ('send_invoice', 'POST', '/invoices/{invoiceId}/send', 'Facturas', 'Enviar factura por email', 'alto'),
      ('create_lead', 'POST', '/leads', 'Oportunidades', 'Crear una oportunidad', 'normal'),
      ('update_lead', 'PUT', '/leads/{leadId}', 'Oportunidades', 'Actualizar una oportunidad', 'normal'),
      ('delete_lead', 'DELETE', '/leads/{leadId}', 'Oportunidades', 'Borrar una oportunidad', 'alto'),
      ('update_lead_dates', 'PUT', '/leads/{leadId}/dates', 'Oportunidades', 'Actualizar fechas de una oportunidad', 'normal'),
      ('update_lead_note', 'PUT', '/leads/{leadId}/notes', 'Oportunidades', 'Actualizar una nota de oportunidad', 'normal'),
      ('create_lead_note', 'POST', '/leads/{leadId}/notes', 'Oportunidades', 'Crear una nota en una oportunidad', 'normal'),
      ('update_lead_stage', 'PUT', '/leads/{leadId}/stage', 'Oportunidades', 'Actualizar la etapa de una oportunidad', 'normal'),
      ('update_lead_task', 'PUT', '/leads/{leadId}/tasks', 'Oportunidades', 'Actualizar una tarea de oportunidad', 'normal'),
      ('create_lead_task', 'POST', '/leads/{leadId}/tasks', 'Oportunidades', 'Crear una tarea en una oportunidad', 'normal'),
      ('delete_lead_task', 'DELETE', '/leads/{leadId}/tasks', 'Oportunidades', 'Borrar una tarea de oportunidad', 'alto'),
      ('create_ledger_entry', 'POST', '/ledger-entries', 'Contabilidad', 'Crear un asiento contable (apunte del libro diario)', 'alto'),
      ('delete_ledger_entry', 'DELETE', '/ledger-entries/{ledgerEntryId}', 'Contabilidad', 'Borrar un asiento contable', 'alto'),
      ('create_numbering_series', 'POST', '/numbering-series/{type}', 'Series de numeración', 'Crear una serie de numeración', 'alto'),
      ('update_numbering_series', 'PUT', '/numbering-series/{type}/{numberingSeriesId}', 'Series de numeración', 'Actualizar una serie de numeración', 'alto'),
      ('delete_numbering_series', 'DELETE', '/numbering-series/{type}/{numberingSeriesId}', 'Series de numeración', 'Borrar una serie de numeración', 'alto'),
      ('create_payment_method', 'POST', '/payment-methods', 'Métodos de pago', 'Crear un método de pago', 'alto'),
      ('update_payment_method', 'PUT', '/payment-methods/{paymentMethodId}', 'Métodos de pago', 'Actualizar un método de pago', 'alto'),
      ('delete_payment_method', 'DELETE', '/payment-methods/{paymentMethodId}', 'Métodos de pago', 'Borrar un método de pago', 'alto'),
      ('create_payment', 'POST', '/payments', 'Pagos', 'Crear un pago', 'alto'),
      ('update_payment', 'PUT', '/payments/{paymentId}', 'Pagos', 'Actualizar un pago', 'alto'),
      ('delete_payment', 'DELETE', '/payments/{paymentId}', 'Pagos', 'Borrar un pago', 'alto'),
      ('create_payslip', 'POST', '/payslips', 'Nóminas', 'Crear nóminas en bloque', 'alto'),
      ('delete_payslip', 'DELETE', '/payslips/{payslipId}', 'Nóminas', 'Borrar una nómina', 'alto'),
      ('approve_payslip', 'POST', '/payslips/{payslipId}/approve', 'Nóminas', 'Aprobar una nómina', 'alto'),
      ('create_payslip_payment', 'POST', '/payslips/{payslipId}/payments', 'Nóminas', 'Registrar un pago de nómina', 'alto'),
      ('delete_payslip_payment', 'DELETE', '/payslips/{payslipId}/payments/{paymentId}', 'Nóminas', 'Eliminar un pago de una nómina', 'alto'),
      ('create_price_list', 'POST', '/price-lists', 'Tarifas', 'Crear una tarifa', 'normal'),
      ('delete_price_list', 'DELETE', '/price-lists/{priceListId}', 'Tarifas', 'Borrar una tarifa', 'alto'),
      ('update_price_list', 'PATCH', '/price-lists/{priceListId}', 'Tarifas', 'Actualizar una tarifa', 'normal'),
      ('create_production_order', 'POST', '/production-orders', 'Órdenes de producción', 'Crear una orden de producción', 'normal'),
      ('update_production_order', 'PUT', '/production-orders/{productionOrderId}', 'Órdenes de producción', 'Actualizar una orden de producción', 'normal'),
      ('delete_production_order', 'DELETE', '/production-orders/{productionOrderId}', 'Órdenes de producción', 'Borrar una orden de producción', 'alto'),
      ('create_product', 'POST', '/products', 'Productos', 'Crear un producto', 'normal'),
      ('update_product', 'PUT', '/products/{productId}', 'Productos', 'Actualizar un producto', 'normal'),
      ('delete_product', 'DELETE', '/products/{productId}', 'Productos', 'Borrar un producto', 'alto'),
      ('update_product_stock', 'PUT', '/products/{productId}/stock', 'Productos', 'Actualizar el stock de un producto', 'normal'),
      ('create_proforma', 'POST', '/proformas', 'Proformas', 'Crear una proforma', 'normal'),
      ('update_proforma', 'PUT', '/proformas/{proformaId}', 'Proformas', 'Actualizar una proforma', 'normal'),
      ('delete_proforma', 'DELETE', '/proformas/{proformaId}', 'Proformas', 'Borrar una proforma', 'alto'),
      ('approve_proforma', 'POST', '/proformas/{proformaId}/approve', 'Proformas', 'Aprobar una proforma', 'alto'),
      ('set_proforma_pipeline', 'PUT', '/proformas/{proformaId}/pipeline', 'Proformas', 'Cambiar la fase de proforma (mover de etapa o estado, pipeline)', 'normal'),
      ('send_proforma', 'POST', '/proformas/{proformaId}/send', 'Proformas', 'Enviar proforma por email', 'alto'),
      ('create_project', 'POST', '/projects', 'Proyectos', 'Crear un proyecto', 'normal'),
      ('update_project', 'PUT', '/projects/{projectId}', 'Proyectos', 'Actualizar un proyecto', 'normal'),
      ('delete_project', 'DELETE', '/projects/{projectId}', 'Proyectos', 'Borrar un proyecto', 'alto'),
      ('create_project_time', 'POST', '/projects/{projectId}/times', 'Control de tiempo en proyectos', 'Crear un registro de tiempo en un proyecto (parte de horas, jornada)', 'normal'),
      ('update_project_time', 'PUT', '/projects/{projectId}/times/{timeId}', 'Control de tiempo en proyectos', 'Actualizar un registro de tiempo de proyecto (parte de horas, jornada)', 'normal'),
      ('delete_project_time', 'DELETE', '/projects/{projectId}/times/{timeId}', 'Control de tiempo en proyectos', 'Borrar un registro de tiempo de proyecto (parte de horas, jornada)', 'alto'),
      ('create_purchase_order', 'POST', '/purchase-orders', 'Pedidos de compra', 'Crear un pedido de compra', 'normal'),
      ('update_purchase_order', 'PUT', '/purchase-orders/{purchaseOrderId}', 'Pedidos de compra', 'Actualizar un pedido de compra', 'normal'),
      ('delete_purchase_order', 'DELETE', '/purchase-orders/{purchaseOrderId}', 'Pedidos de compra', 'Borrar un pedido de compra', 'alto'),
      ('approve_purchase_order', 'POST', '/purchase-orders/{purchaseOrderId}/approve', 'Pedidos de compra', 'Aprobar un pedido de compra', 'alto'),
      ('set_purchase_order_pipeline', 'PUT', '/purchase-orders/{purchaseOrderId}/pipeline', 'Pedidos de compra', 'Cambiar la fase de pedido de compra (mover de etapa o estado, pipeline)', 'normal'),
      ('receive_purchase_order', 'POST', '/purchase-orders/{purchaseOrderId}/receive', 'Pedidos de compra', 'Recibir unidades de un pedido de compra', 'normal'),
      ('send_purchase_order', 'POST', '/purchase-orders/{purchaseOrderId}/send', 'Pedidos de compra', 'Enviar pedido de compra por email', 'alto'),
      ('create_purchase_receipt', 'POST', '/purchase-receipts', 'Tickets de compra', 'Crear un ticket de compra', 'normal'),
      ('update_purchase_receipt', 'PUT', '/purchase-receipts/{purchaseReceiptId}', 'Tickets de compra', 'Actualizar un ticket de compra', 'normal'),
      ('delete_purchase_receipt', 'DELETE', '/purchase-receipts/{purchaseReceiptId}', 'Tickets de compra', 'Borrar un ticket de compra', 'alto'),
      ('create_purchase_shipment', 'POST', '/purchase-shipments', 'Albaranes de compra', 'Crear un albarán de compra', 'normal'),
      ('update_purchase_shipment', 'PUT', '/purchase-shipments/{purchaseShipmentId}', 'Albaranes de compra', 'Actualizar un albarán de compra', 'normal'),
      ('delete_purchase_shipment', 'DELETE', '/purchase-shipments/{purchaseShipmentId}', 'Albaranes de compra', 'Borrar un albarán de compra', 'alto'),
      ('approve_purchase_shipment', 'POST', '/purchase-shipments/{purchaseShipmentId}/approve', 'Albaranes de compra', 'Aprobar un albarán de compra', 'alto'),
      ('create_purchase', 'POST', '/purchases', 'Compras', 'Crear una compra', 'normal'),
      ('create_purchase_refund', 'POST', '/purchases/refund', 'Compras', 'Crear una compra rectificativa', 'alto'),
      ('update_purchase', 'PUT', '/purchases/{purchaseId}', 'Compras', 'Actualizar una compra', 'normal'),
      ('delete_purchase', 'DELETE', '/purchases/{purchaseId}', 'Compras', 'Borrar una compra', 'alto'),
      ('approve_purchase', 'POST', '/purchases/{purchaseId}/approve', 'Compras', 'Aprobar una compra', 'alto'),
      ('create_purchase_payment', 'POST', '/purchases/{purchaseId}/payments', 'Compras', 'Registrar un pago de compra', 'alto'),
      ('set_purchase_pipeline', 'PUT', '/purchases/{purchaseId}/pipeline', 'Compras', 'Cambiar la fase de compra (mover de etapa o estado, pipeline)', 'normal'),
      ('create_receipt_note', 'POST', '/receipt-notes', 'Rectificativas de venta', 'Crear una rectificativa de ticket de venta (nota de recibo)', 'normal'),
      ('update_receipt_note', 'PUT', '/receipt-notes/{receiptNoteId}', 'Rectificativas de venta', 'Actualizar una rectificativa de ticket de venta (nota de recibo)', 'normal'),
      ('delete_receipt_note', 'DELETE', '/receipt-notes/{receiptNoteId}', 'Rectificativas de venta', 'Borrar una rectificativa de ticket de venta (nota de recibo)', 'alto'),
      ('approve_receipt_note', 'POST', '/receipt-notes/{receiptNoteId}/approve', 'Rectificativas de venta', 'Aprobar una rectificativa de ticket de venta (nota de recibo)', 'alto'),
      ('create_receipt_note_payment', 'POST', '/receipt-notes/{receiptNoteId}/payments', 'Rectificativas de venta', 'Registrar un pago de rectificativa de ticket de venta (nota de recibo)', 'alto'),
      ('set_receipt_note_pipeline', 'PUT', '/receipt-notes/{receiptNoteId}/pipeline', 'Rectificativas de venta', 'Cambiar la fase de la rectificativa de ticket de venta o nota de recibo (mover de etapa o estado, pipeline)', 'normal'),
      ('send_receipt_note', 'POST', '/receipt-notes/{receiptNoteId}/send', 'Rectificativas de venta', 'Enviar rectificativa de ticket de venta (nota de recibo) por correo electrónico', 'alto'),
      ('create_invoice_recurring', 'POST', '/recurring-invoices', 'Facturas recurrentes', 'Crear una factura recurrente', 'alto'),
      ('update_invoice_recurring', 'PUT', '/recurring-invoices/{invoiceRecurringId}', 'Facturas recurrentes', 'Actualizar una factura recurrente', 'alto'),
      ('delete_invoice_recurring', 'DELETE', '/recurring-invoices/{invoiceRecurringId}', 'Facturas recurrentes', 'Borrar una factura recurrente', 'alto'),
      ('skip_recurring_occurrence', 'POST', '/recurring-invoices/{invoiceRecurringId}/skip', 'Facturas recurrentes', 'Omitir una ocurrencia de factura recurrente', 'alto'),
      ('create_salary_record', 'POST', '/salary-records', 'Registros de nómina', 'Crear un registro de nómina', 'alto'),
      ('update_salary_record', 'PUT', '/salary-records/{salaryRecordId}', 'Registros de nómina', 'Actualizar un registro de nómina', 'alto'),
      ('delete_salary_record', 'DELETE', '/salary-records/{salaryRecordId}', 'Registros de nómina', 'Borrar un registro de nómina', 'alto'),
      ('create_sales_channel', 'POST', '/sales-channels', 'Canales de venta', 'Crear un canal de venta', 'normal'),
      ('update_sales_channel', 'PUT', '/sales-channels/{salesChannelId}', 'Canales de venta', 'Actualizar un canal de venta', 'normal'),
      ('delete_sales_channel', 'DELETE', '/sales-channels/{salesChannelId}', 'Canales de venta', 'Borrar un canal de venta', 'alto'),
      ('create_sales_order', 'POST', '/sales-orders', 'Pedidos de venta', 'Crear un pedido de venta', 'normal'),
      ('update_sales_order', 'PUT', '/sales-orders/{salesOrderId}', 'Pedidos de venta', 'Actualizar un pedido de venta', 'normal'),
      ('delete_sales_order', 'DELETE', '/sales-orders/{salesOrderId}', 'Pedidos de venta', 'Borrar un pedido de venta', 'alto'),
      ('accept_sales_order', 'POST', '/sales-orders/{salesOrderId}/accept', 'Pedidos de venta', 'Aceptar un pedido de venta', 'normal'),
      ('approve_sales_order', 'POST', '/sales-orders/{salesOrderId}/approve', 'Pedidos de venta', 'Aprobar un pedido de venta', 'alto'),
      ('cancel_sales_order', 'POST', '/sales-orders/{salesOrderId}/cancel', 'Pedidos de venta', 'Cancelar un pedido de venta', 'alto'),
      ('set_sales_order_pipeline', 'PUT', '/sales-orders/{salesOrderId}/pipeline', 'Pedidos de venta', 'Cambiar la fase de pedido de venta (mover de etapa o estado, pipeline)', 'normal'),
      ('send_sales_order', 'POST', '/sales-orders/{salesOrderId}/send', 'Pedidos de venta', 'Enviar pedido de venta por email', 'alto'),
      ('ship_sales_order', 'POST', '/sales-orders/{salesOrderId}/ship', 'Pedidos de venta', 'Enviar todos los artículos de un pedido de venta', 'normal'),
      ('ship_sales_order_by_lines', 'POST', '/sales-orders/{salesOrderId}/ship-by-lines', 'Pedidos de venta', 'Envío parcial de un pedido de venta', 'normal'),
      ('update_sales_order_tracking', 'PUT', '/sales-orders/{salesOrderId}/tracking', 'Pedidos de venta', 'Actualizar información de seguimiento del pedido de venta', 'normal'),
      ('create_sales_receipt', 'POST', '/sales-receipts', 'Tickets de venta', 'Crear un ticket de venta', 'normal'),
      ('update_sales_receipt', 'PUT', '/sales-receipts/{salesReceiptId}', 'Tickets de venta', 'Actualizar un ticket de venta', 'normal'),
      ('delete_sales_receipt', 'DELETE', '/sales-receipts/{salesReceiptId}', 'Tickets de venta', 'Borrar un ticket de venta', 'alto'),
      ('approve_sales_receipt', 'POST', '/sales-receipts/{salesReceiptId}/approve', 'Tickets de venta', 'Aprobar un ticket de venta', 'alto'),
      ('create_sales_receipt_payment', 'POST', '/sales-receipts/{salesReceiptId}/payments', 'Tickets de venta', 'Registrar un pago de ticket de venta', 'alto'),
      ('set_sales_receipt_pipeline', 'PUT', '/sales-receipts/{salesReceiptId}/pipeline', 'Tickets de venta', 'Cambiar la fase de ticket de venta (mover de etapa o estado, pipeline)', 'normal'),
      ('send_sales_receipt', 'POST', '/sales-receipts/{salesReceiptId}/send', 'Tickets de venta', 'Enviar ticket de venta por email', 'alto'),
      ('create_service', 'POST', '/services', 'Servicios', 'Crear un servicio', 'normal'),
      ('update_service', 'PUT', '/services/{serviceId}', 'Servicios', 'Actualizar un servicio', 'normal'),
      ('delete_service', 'DELETE', '/services/{serviceId}', 'Servicios', 'Borrar un servicio', 'alto'),
      ('create_assignment', 'POST', '/shift-assignments', 'Asignaciones de turnos', 'Asignar un turno a uno o varios empleados en un rango de fechas', 'normal'),
      ('batch_delete_assignments', 'POST', '/shift-assignments/batch-delete', 'Asignaciones de turnos', 'Eliminar asignaciones de turnos en lote', 'alto'),
      ('create_shift_calendar', 'POST', '/shift-calendars', 'Calendarios de turnos', 'Crear un calendario de turnos', 'normal'),
      ('update_shift_calendar', 'PUT', '/shift-calendars/{calendarId}', 'Calendarios de turnos', 'Actualizar un calendario de turnos', 'normal'),
      ('delete_shift_calendar', 'DELETE', '/shift-calendars/{calendarId}', 'Calendarios de turnos', 'Eliminar un calendario de turnos', 'alto'),
      ('update_assignment', 'PUT', '/shift-calendars/{calendarId}/assignments/{assignmentId}', 'Asignaciones de turnos', 'Actualizar una asignación de turno', 'normal'),
      ('delete_assignment', 'DELETE', '/shift-calendars/{calendarId}/assignments/{assignmentId}', 'Asignaciones de turnos', 'Eliminar una asignación de turno', 'alto'),
      ('publish_shift_calendar', 'POST', '/shift-calendars/{calendarId}/publish', 'Calendarios de turnos', 'Publicar un calendario de turnos', 'alto'),
      ('update_recurrency', 'PUT', '/shift-recurrencies/{recurrencyId}', 'Recurrencias de turnos', 'Actualizar una recurrencia de turnos', 'normal'),
      ('delete_recurrency', 'DELETE', '/shift-recurrencies/{recurrencyId}', 'Recurrencias de turnos', 'Eliminar una recurrencia de turnos', 'alto'),
      ('create_shift', 'POST', '/shifts', 'Turnos', 'Crear un turno', 'normal'),
      ('update_shift', 'PUT', '/shifts/{shiftId}', 'Turnos', 'Actualizar un turno', 'normal'),
      ('delete_shift', 'DELETE', '/shifts/{shiftId}', 'Turnos', 'Borrar un turno', 'alto'),
      ('create_tag', 'POST', '/tags', 'Etiquetas', 'Crear una etiqueta', 'normal'),
      ('delete_tag', 'DELETE', '/tags/{tag}', 'Etiquetas', 'Borrar una etiqueta', 'alto'),
      ('create_task', 'POST', '/tasks', 'Tareas', 'Crear una tarea', 'normal'),
      ('update_task', 'PUT', '/tasks/{taskId}', 'Tareas', 'Actualizar una tarea', 'normal'),
      ('delete_task', 'DELETE', '/tasks/{taskId}', 'Tareas', 'Borrar una tarea', 'alto'),
      ('create_banking_account', 'POST', '/treasury/accounts', 'Cuentas bancarias', 'Crear una cuenta bancaria', 'alto'),
      ('create_bank_movement', 'POST', '/treasury/accounts/{bankingAccountId}/bank-movements', 'Cuentas bancarias', 'Crear un movimiento bancario manual', 'alto'),
      ('reconcile_transaction_with_document', 'POST', '/treasury/accounts/{bankingAccountId}/bank-movements/{movementId}/reconcile', 'Cuentas bancarias', 'Conciliar un movimiento bancario', 'alto'),
      ('update_banking_account', 'PUT', '/treasury/accounts/{id}', 'Cuentas bancarias', 'Actualizar una cuenta bancaria', 'alto'),
      ('delete_banking_account', 'DELETE', '/treasury/accounts/{id}', 'Cuentas bancarias', 'Borrar una cuenta bancaria', 'alto'),
      ('archive_banking_account', 'POST', '/treasury/accounts/{id}/archive', 'Cuentas bancarias', 'Archivar una cuenta bancaria', 'alto'),
      ('create_invoicing_forecast', 'POST', '/treasury/cashflow/invoicing-forecasts', 'Previsiones de facturación', 'Crear una previsión de facturación', 'normal'),
      ('edit_invoicing_forecast', 'PUT', '/treasury/cashflow/invoicing-forecasts/{forecastId}', 'Previsiones de facturación', 'Editar una previsión de facturación', 'normal'),
      ('delete_invoicing_forecast', 'DELETE', '/treasury/cashflow/invoicing-forecasts/{forecastId}', 'Previsiones de facturación', 'Borrar una previsión de facturación', 'alto'),
      ('create_warehouse', 'POST', '/warehouses', 'Almacenes', 'Crear un almacén', 'normal'),
      ('delete_warehouse', 'DELETE', '/warehouses/{warehouseId}', 'Almacenes', 'Borrar un almacén', 'alto'),
      ('update_warehouse', 'PATCH', '/warehouses/{warehouseId}', 'Almacenes', 'Actualizar un almacén', 'normal'),
      ('create_waybill', 'POST', '/waybills', 'Albaranes', 'Crear un albarán', 'normal'),
      ('update_waybill', 'PUT', '/waybills/{waybillId}', 'Albaranes', 'Actualizar un albarán', 'normal'),
      ('delete_waybill', 'DELETE', '/waybills/{waybillId}', 'Albaranes', 'Borrar un albarán', 'alto'),
      ('approve_waybill', 'POST', '/waybills/{waybillId}/approve', 'Albaranes', 'Aprobar un albarán', 'alto'),
      ('set_waybill_pipeline', 'PUT', '/waybills/{waybillId}/pipeline', 'Albaranes', 'Cambiar la fase de albarán (mover de etapa o estado, pipeline)', 'normal'),
      ('send_waybill', 'POST', '/waybills/{waybillId}/send', 'Albaranes', 'Enviar albarán por email', 'alto'),
      ('update_waybill_tracking', 'PUT', '/waybills/{waybillId}/tracking', 'Albaranes', 'Actualizar información de seguimiento del albarán', 'normal'),
      ('create_webhook', 'POST', '/webhooks', 'Webhooks', 'Crear un webhook', 'alto'),
      ('update_webhook', 'PUT', '/webhooks/{webhookId}', 'Webhooks', 'Actualizar un webhook', 'alto'),
      ('delete_webhook', 'DELETE', '/webhooks/{webhookId}', 'Webhooks', 'Eliminar un webhook', 'alto'),
      ('disable_webhook', 'POST', '/webhooks/{webhookId}/disable', 'Webhooks', 'Deshabilitar un webhook', 'alto'),
      ('enable_webhook', 'POST', '/webhooks/{webhookId}/enable', 'Webhooks', 'Habilitar un webhook', 'alto');
    -- </catalogo>

  -- ===================== acciones: tipo operacion =====================
  select conname into v_c from pg_constraint
   where conrelid = 'public.holded_acciones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%aprobar_tickets_venta%';
  execute format('alter table public.holded_acciones drop constraint %I', v_c);
  alter table public.holded_acciones
    add constraint holded_acciones_tipo_check check (tipo in ('aprobar_tickets_venta', 'operacion')),
    add column operacion text references public.holded_operaciones(id),
    add column riesgo text check (riesgo is null or riesgo in ('normal', 'alto')),
    add column descripcion text check (descripcion is null or length(descripcion) <= 300),
    add column purgada_at timestamptz,
    add constraint holded_acciones_operacion_check
      check ((tipo = 'operacion') = (operacion is not null and riesgo is not null and descripcion is not null));

  -- ===================== items: peticiones =====================
  alter table public.holded_acciones_items drop constraint holded_acciones_items_pkey;
  alter table public.holded_acciones_items alter column holded_id drop not null;
  alter table public.holded_acciones_items add primary key (accion_id, orden);
  create unique index holded_acciones_items_doc on public.holded_acciones_items (accion_id, holded_id) where holded_id is not null;
  select conname into v_c from pg_constraint
   where conrelid = 'public.holded_acciones_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%en_proceso%';
  execute format('alter table public.holded_acciones_items drop constraint %I', v_c);
  alter table public.holded_acciones_items
    add constraint holded_acciones_items_estado_check
      check (estado in ('pendiente', 'en_proceso', 'ok', 'error', 'omitido', 'desconocido')),
    add column metodo text check (metodo is null or metodo in ('POST', 'PUT', 'PATCH', 'DELETE')),
    add column ruta text check (ruta is null or (length(ruta) <= 400 and ruta ~ '^/[A-Za-z0-9/_.%?=&-]+$')),
    add column cuerpo jsonb check (cuerpo is null or pg_column_size(cuerpo) <= 65536),
    add column estado_anterior jsonb check (estado_anterior is null or pg_column_size(estado_anterior) <= 65536),
    add column resultado_id text check (resultado_id is null or resultado_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    add column purgado_at timestamptz,
    add constraint holded_acciones_items_que check (holded_id is not null or (metodo is not null and ruta is not null));

  -- ===================== políticas: por operación =====================
  select conname into v_c from pg_constraint
   where conrelid = 'public.holded_acciones_politicas'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%aprobar_tickets_venta%';
  execute format('alter table public.holded_acciones_politicas drop constraint %I', v_c);
  select conname into v_c from pg_constraint
   where conrelid = 'public.holded_acciones_politicas'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%max_importe IS NOT NULL%';
  execute format('alter table public.holded_acciones_politicas drop constraint %I', v_c);
  alter table public.holded_acciones_politicas
    add constraint holded_acciones_politicas_tipo_check check (tipo ~ '^[A-Za-z0-9_]{1,80}$'),
    add constraint holded_acciones_politicas_topes
      check (modo = 'aprobacion' or (max_documentos is not null and (tipo <> 'aprobar_tickets_venta' or max_importe is not null)));
  -- Una política automática solo para operaciones de riesgo normal del catálogo.
  create function public.holded_politica_valida() returns trigger
  language plpgsql set search_path = public, pg_temp as $f$
  declare v_riesgo text;
  begin
    if new.tipo = 'aprobar_tickets_venta' then return new; end if;
    select riesgo into v_riesgo from public.holded_operaciones where id = new.tipo;
    if not found then raise exception 'Operación de Holded desconocida: %', new.tipo using errcode = '22023'; end if;
    if new.modo = 'automatica' and v_riesgo = 'alto' then
      raise exception 'Las operaciones de riesgo alto no pueden ser automáticas' using errcode = '22023';
    end if;
    return new;
  end; $f$;
  create trigger holded_acciones_politicas_valida before insert or update on public.holded_acciones_politicas
    for each row execute function public.holded_politica_valida();

  -- ===================== cupo por defecto =====================
  alter table public.holded_conexiones alter column cupo_acciones_mensual set default 50;
  update public.holded_conexiones set cupo_acciones_mensual = 50 where cupo_acciones_mensual = 0;

  -- ===================== proponer una operación (service_role) =====================
  -- p_peticiones: [{metodo, ruta, cuerpo?, estado_anterior?, holded_id?}], 1–100.
  create function public.holded_acciones_crear_operacion(
    p_usuario uuid, p_origen text, p_empresa uuid, p_operacion text, p_descripcion text,
    p_resumen jsonb, p_muestra jsonb, p_avisos text[], p_peticiones jsonb, p_llamadas integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_op public.holded_operaciones%rowtype;
    v_n int; v_id uuid; v_estado text := 'propuesta'; v_re text;
    v_pol public.holded_acciones_politicas%rowtype; v_restante int;
    p jsonb;
  begin
    if p_origen not in ('agente', 'crm', 'operador') then
      raise exception 'Origen no válido' using errcode = '22023';
    end if;
    if p_origen <> 'operador' and not public.is_admin(p_usuario) then
      raise exception 'Solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into v_op from public.holded_operaciones where id = p_operacion;
    if not found then raise exception 'Operación de Holded no permitida' using errcode = '22023'; end if;
    if not exists (select 1 from public.holded_conexiones where empresa_id = p_empresa) then
      raise exception 'La empresa no tiene Holded conectado' using errcode = 'GU010';
    end if;
    if nullif(btrim(coalesce(p_descripcion, '')), '') is null or length(p_descripcion) > 300 then
      raise exception 'Falta la descripción legible (como mucho 300 caracteres)' using errcode = '22023';
    end if;
    v_n := case when jsonb_typeof(p_peticiones) = 'array' then jsonb_array_length(p_peticiones) else 0 end;
    if v_n < 1 or v_n > 100 then
      raise exception 'Una propuesta tiene entre 1 y 100 operaciones' using errcode = '22023';
    end if;
    v_re := '^' || regexp_replace(v_op.ruta, '\{[^}]+\}', '[A-Za-z0-9_.%-]+', 'g') || '(\?[A-Za-z0-9_.%=&-]*)?$';
    for p in select value from jsonb_array_elements(p_peticiones) loop
      if p->>'metodo' is distinct from v_op.metodo or coalesce(p->>'ruta', '') !~ v_re then
        raise exception 'Petición fuera de la operación %', v_op.id using errcode = '22023';
      end if;
    end loop;

    select * into v_pol from public.holded_acciones_politicas where empresa_id = p_empresa and tipo = v_op.id;
    if found and v_pol.modo = 'automatica' and v_op.riesgo = 'normal' and v_n <= v_pol.max_documentos then
      v_estado := 'aprobada';
    end if;

    select greatest(c.cupo_acciones_mensual - (select count(*) from public.holded_acciones_items i
                      join public.holded_acciones a on a.id = i.accion_id
                     where a.empresa_id = p_empresa and i.primer_intento_at >= public.holded_inicio_mes()), 0)
      into v_restante from public.holded_conexiones c where c.empresa_id = p_empresa;
    if v_n > v_restante then
      p_avisos := coalesce(p_avisos, '{}') || format('⚠ CUPO: esta propuesta necesita %s operación(es) y el cupo de acciones de este mes solo cubre %s. Amplíalo desde la propuesta antes de aprobarla o se pausará al llegar.', v_n, v_restante);
    end if;

    insert into public.holded_acciones (empresa_id, tipo, operacion, riesgo, descripcion, parametros, resumen, muestra, avisos,
                                        estado, motivo_estado, origen, propuesta_por, aprobada_at, llamadas_lectura)
    values (p_empresa, 'operacion', v_op.id, v_op.riesgo, btrim(p_descripcion),
            jsonb_build_object('operacion', v_op.id, 'metodo', v_op.metodo, 'ruta', v_op.ruta),
            coalesce(p_resumen, '{}'::jsonb) || jsonb_build_object('documentos', v_n, 'riesgo', v_op.riesgo),
            coalesce(p_muestra, '[]'::jsonb), coalesce(p_avisos, '{}'), v_estado,
            case when v_estado = 'aprobada' then 'Aprobada por la política automática de la empresa' end,
            p_origen, p_usuario, case when v_estado = 'aprobada' then now() end, greatest(coalesce(p_llamadas, 0), 0))
    returning id into v_id;
    insert into public.holded_acciones_items (accion_id, orden, holded_id, metodo, ruta, cuerpo, estado_anterior)
    select v_id, o::int, nullif(x->>'holded_id', ''), x->>'metodo', x->>'ruta',
           case when x ? 'cuerpo' and x->'cuerpo' <> 'null'::jsonb then x->'cuerpo' end,
           case when x ? 'estado_anterior' and x->'estado_anterior' <> 'null'::jsonb then x->'estado_anterior' end
      from jsonb_array_elements(p_peticiones) with ordinality as t(x, o);
    return jsonb_build_object('id', v_id, 'estado', v_estado, 'documentos', v_n, 'riesgo', v_op.riesgo);
  end;
  $f$;

  -- ===================== aprobar (rol admin; CONFIRMAR si es de riesgo alto) =====================
  drop function public.holded_acciones_aprobar(uuid, integer);
  create function public.holded_acciones_aprobar(p_accion uuid, p_confirmacion integer, p_texto text default null)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_a public.holded_acciones%rowtype; v_n int;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede aprobar acciones en Holded' using errcode = '42501';
    end if;
    select * into v_a from public.holded_acciones where id = p_accion for update;
    if not found then raise exception 'Esa acción no existe' using errcode = 'GU010'; end if;
    if v_a.estado <> 'propuesta' then
      raise exception 'Solo se puede aprobar una propuesta (esta está «%»)', v_a.estado using errcode = '22023';
    end if;
    if v_a.expira_at <= now() then
      raise exception 'La propuesta ha caducado (72 h): pide una nueva, los datos de Holded pueden haber cambiado' using errcode = '22023';
    end if;
    select count(*) into v_n from public.holded_acciones_items where accion_id = p_accion;
    if v_n > 100 and p_confirmacion is distinct from v_n then
      raise exception 'Para aprobar % documentos escribe el número % como confirmación', v_n, v_n using errcode = '22023';
    end if;
    if v_a.riesgo = 'alto' and upper(btrim(coalesce(p_texto, ''))) <> 'CONFIRMAR' then
      raise exception 'Es una operación de riesgo alto: escribe CONFIRMAR para aprobarla' using errcode = '22023';
    end if;
    update public.holded_acciones
       set estado = 'aprobada', aprobada_por = auth.uid(), aprobada_at = now(), motivo_estado = null
     where id = p_accion;
    return jsonb_build_object('id', p_accion, 'estado', 'aprobada', 'documentos', v_n);
  end;
  $f$;

  -- ===================== reclamar (service_role): por orden; devuelve peticiones =====================
  create or replace function public.holded_acciones_reclamar(p_max integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_a public.holded_acciones%rowtype;
    v_cupo int; v_usadas int; v_k int; v_ids text[]; v_pet jsonb;
  begin
    if p_max is null or p_max < 1 or p_max > 50 then
      raise exception 'Lote no válido' using errcode = '22023';
    end if;
    for v_a in select * from public.holded_acciones where estado in ('aprobada', 'en_curso')
                order by aprobada_at, id for update skip locked loop
      update public.holded_acciones_items set estado = 'pendiente'
       where accion_id = v_a.id and estado = 'en_proceso' and reclamado_at < now() - interval '5 minutes'
         and coalesce(metodo, '') <> 'POST';
      -- Un POST atascado (la ejecución murió sin saber si Holded lo hizo) no se repite solo.
      update public.holded_acciones_items
         set estado = 'desconocido', procesado_at = now(),
             error = 'La ejecución se interrumpió sin respuesta: puede que se haya hecho; revísalo en Holded'
       where accion_id = v_a.id and estado = 'en_proceso' and reclamado_at < now() - interval '5 minutes' and metodo = 'POST';

      if not exists (select 1 from public.holded_acciones_items where accion_id = v_a.id and estado in ('pendiente', 'en_proceso')) then
        update public.holded_acciones set estado = 'completada', terminada_at = now() where id = v_a.id;
        continue;
      end if;
      if not exists (select 1 from public.holded_acciones_items where accion_id = v_a.id and estado = 'pendiente') then
        continue;
      end if;
      select cupo_acciones_mensual into v_cupo from public.holded_conexiones where empresa_id = v_a.empresa_id;
      if not found then
        update public.holded_acciones set estado = 'pausada', motivo_estado = 'La empresa ya no tiene Holded conectado' where id = v_a.id;
        continue;
      end if;
      select count(*) into v_usadas from public.holded_acciones_items i join public.holded_acciones a on a.id = i.accion_id
       where a.empresa_id = v_a.empresa_id and i.primer_intento_at >= public.holded_inicio_mes();
      v_k := least(p_max, greatest(v_cupo - v_usadas, 0)
                          + (select count(*) from public.holded_acciones_items
                              where accion_id = v_a.id and estado = 'pendiente' and primer_intento_at >= public.holded_inicio_mes())::int);
      if v_k <= 0 then
        update public.holded_acciones
           set estado = 'pausada', motivo_estado = format('Cupo de acciones del mes agotado (%s de %s documentos)', v_usadas, v_cupo)
         where id = v_a.id;
        continue;
      end if;
      with c as (
        select orden from public.holded_acciones_items
         where accion_id = v_a.id and estado = 'pendiente'
         order by (primer_intento_at is null), orden
         limit v_k
         for update skip locked)
      update public.holded_acciones_items i
         set estado = 'en_proceso', intentos = i.intentos + 1, reclamado_at = now(),
             primer_intento_at = coalesce(i.primer_intento_at, now())
        from c where i.accion_id = v_a.id and i.orden = c.orden;
      select array_agg(holded_id order by orden),
             jsonb_agg(jsonb_build_object('orden', orden, 'metodo', metodo, 'ruta', ruta, 'cuerpo', cuerpo) order by orden)
        into v_ids, v_pet
        from public.holded_acciones_items
       where accion_id = v_a.id and estado = 'en_proceso' and reclamado_at = now();
      update public.holded_acciones
         set estado = 'en_curso', iniciada_at = coalesce(iniciada_at, now())
       where id = v_a.id and estado = 'aprobada';
      if v_a.tipo = 'operacion' then
        return jsonb_build_object('accion_id', v_a.id, 'empresa_id', v_a.empresa_id, 'tipo', v_a.tipo,
                                  'operacion', v_a.operacion, 'peticiones', coalesce(v_pet, '[]'::jsonb));
      end if;
      return jsonb_build_object('accion_id', v_a.id, 'empresa_id', v_a.empresa_id, 'tipo', v_a.tipo, 'ids', to_jsonb(coalesce(v_ids, '{}')));
    end loop;
    return null;
  end;
  $f$;

  -- ===================== resultados (service_role): por orden o por id =====================
  -- [{orden | id, estado: ok|error|pendiente|desconocido, codigo, error, resultado_id}]
  create or replace function public.holded_acciones_resultado(p_accion uuid, p_resultados jsonb, p_llamadas integer, p_pausar text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare r jsonb; v_estado text; v_res text;
  begin
    for r in select value from jsonb_array_elements(coalesce(p_resultados, '[]'::jsonb)) loop
      v_estado := r->>'estado';
      if v_estado not in ('ok', 'error', 'pendiente', 'desconocido') then
        raise exception 'Resultado no válido' using errcode = '22023';
      end if;
      v_res := nullif(r->>'resultado_id', '');
      if v_res is not null and v_res !~ '^[A-Za-z0-9_-]{1,64}$' then v_res := null; end if;
      update public.holded_acciones_items i
         set estado = case when v_estado = 'pendiente' and i.intentos >= 3 then 'error' else v_estado end,
             codigo = nullif(r->>'codigo', '')::int,
             error = case when v_estado = 'ok' then null
                          when v_estado = 'pendiente' and i.intentos >= 3 then left(coalesce(r->>'error', 'Sin respuesta de Holded') || ' (3 intentos)', 300)
                          else left(r->>'error', 300) end,
             resultado_id = coalesce(v_res, i.resultado_id),
             procesado_at = case when v_estado = 'pendiente' and i.intentos < 3 then i.procesado_at else now() end
       where i.accion_id = p_accion and i.estado = 'en_proceso'
         and (case when r ? 'orden' then i.orden = (r->>'orden')::int else i.holded_id = r->>'id' end);
    end loop;
    update public.holded_acciones
       set llamadas_escritura = llamadas_escritura + greatest(coalesce(p_llamadas, 0), 0)
     where id = p_accion;
    if nullif(btrim(coalesce(p_pausar, '')), '') is not null then
      update public.holded_acciones set estado = 'pausada', motivo_estado = left(p_pausar, 300)
       where id = p_accion and estado in ('aprobada', 'en_curso');
    end if;
    if not exists (select 1 from public.holded_acciones_items where accion_id = p_accion and estado in ('pendiente', 'en_proceso')) then
      update public.holded_acciones set estado = 'completada', terminada_at = now()
       where id = p_accion and estado in ('aprobada', 'en_curso');
    end if;
    return (select jsonb_build_object('estado', estado) from public.holded_acciones where id = p_accion);
  end;
  $f$;

  -- ===================== progreso (rol admin) =====================
  create or replace function public.holded_acciones_progreso(p_accion uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin' using errcode = '42501';
    end if;
    return (
      select jsonb_build_object(
        'total', count(*),
        'pendiente', count(*) filter (where estado = 'pendiente'),
        'en_proceso', count(*) filter (where estado = 'en_proceso'),
        'ok', count(*) filter (where estado = 'ok'),
        'error', count(*) filter (where estado = 'error'),
        'omitido', count(*) filter (where estado = 'omitido'),
        'desconocido', count(*) filter (where estado = 'desconocido'),
        'ultimo_at', max(procesado_at),
        'errores', coalesce((select jsonb_agg(jsonb_build_object('orden', e.orden, 'holded_id', e.holded_id, 'ruta', e.ruta, 'estado', e.estado,
                                                                 'codigo', e.codigo, 'error', e.error) order by e.orden)
                               from (select * from public.holded_acciones_items
                                      where accion_id = p_accion and estado in ('error', 'desconocido') order by orden limit 200) e), '[]'::jsonb))
        from public.holded_acciones_items where accion_id = p_accion);
  end;
  $f$;

  -- Peticiones de una operación (rol admin): la petición exacta y el estado anterior.
  create function public.holded_acciones_peticiones(p_accion uuid, p_desde integer, p_n integer)
  returns table (orden integer, holded_id text, metodo text, ruta text, cuerpo jsonb, estado_anterior jsonb,
                 estado text, codigo integer, error text, resultado_id text, purgado boolean)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin' using errcode = '42501';
    end if;
    return query
      select i.orden, i.holded_id, i.metodo, i.ruta, i.cuerpo, i.estado_anterior, i.estado, i.codigo, i.error, i.resultado_id,
             i.purgado_at is not null
        from public.holded_acciones_items i
       where i.accion_id = p_accion and i.orden >= coalesce(p_desde, 1)
       order by i.orden limit least(greatest(coalesce(p_n, 20), 1), 50);
  end;
  $f$;

  -- Política por empresa y operación (rol admin). «aprobacion» borra la fila.
  create function public.holded_cambiar_politica(p_empresa_id uuid, p_tipo text, p_modo text, p_max_documentos integer, p_max_importe numeric)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede cambiar las políticas' using errcode = '42501';
    end if;
    if not exists (select 1 from public.holded_conexiones where empresa_id = p_empresa_id) then
      raise exception 'Esa empresa no tiene Holded conectado' using errcode = 'GU010';
    end if;
    if p_modo = 'aprobacion' then
      delete from public.holded_acciones_politicas where empresa_id = p_empresa_id and tipo = p_tipo;
      return jsonb_build_object('empresa_id', p_empresa_id, 'tipo', p_tipo, 'modo', 'aprobacion');
    end if;
    if p_modo is distinct from 'automatica' then raise exception 'Modo no válido' using errcode = '22023'; end if;
    insert into public.holded_acciones_politicas (empresa_id, tipo, modo, max_documentos, max_importe, updated_by, updated_at)
    values (p_empresa_id, p_tipo, 'automatica', p_max_documentos, p_max_importe, auth.uid(), now())
    on conflict (empresa_id, tipo) do update
      set modo = excluded.modo, max_documentos = excluded.max_documentos, max_importe = excluded.max_importe,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    return jsonb_build_object('empresa_id', p_empresa_id, 'tipo', p_tipo, 'modo', 'automatica');
  end;
  $f$;

  -- ===================== retención: 90 días =====================
  create function public.holded_acciones_purgar()
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_n int;
  begin
    with viejas as (
      select id from public.holded_acciones
       where (estado in ('completada', 'cancelada', 'rechazada') and coalesce(terminada_at, updated_at) < now() - interval '90 days')
          or (estado = 'propuesta' and expira_at < now() - interval '90 days'))
    update public.holded_acciones_items i
       set cuerpo = null, estado_anterior = null, purgado_at = now()
      from viejas v
     where i.accion_id = v.id and (i.cuerpo is not null or i.estado_anterior is not null);
    get diagnostics v_n = row_count;
    update public.holded_acciones
       set muestra = '[]'::jsonb, purgada_at = now()
     where tipo = 'operacion' and purgada_at is null
       and ((estado in ('completada', 'cancelada', 'rechazada') and coalesce(terminada_at, updated_at) < now() - interval '90 days')
            or (estado = 'propuesta' and expira_at < now() - interval '90 days'));
    return v_n;
  end;
  $f$;

  -- ===================== privilegios =====================
  revoke all on function public.holded_acciones_crear_operacion(uuid, text, uuid, text, text, jsonb, jsonb, text[], jsonb, integer),
                         public.holded_acciones_aprobar(uuid, integer, text), public.holded_acciones_peticiones(uuid, integer, integer),
                         public.holded_cambiar_politica(uuid, text, text, integer, numeric), public.holded_acciones_purgar(),
                         public.holded_politica_valida()
    from public, anon, authenticated, service_role;
  grant execute on function public.holded_acciones_crear_operacion(uuid, text, uuid, text, text, jsonb, jsonb, text[], jsonb, integer)
    to service_role;
  grant execute on function public.holded_acciones_aprobar(uuid, integer, text), public.holded_acciones_peticiones(uuid, integer, integer),
                            public.holded_cambiar_politica(uuid, text, text, integer, numeric)
    to authenticated;

  perform cron.unschedule(jobid) from cron.job where jobname = 'holded-acciones-purgar';
  perform cron.schedule('holded-acciones-purgar', '17 3 * * *', 'select public.holded_acciones_purgar();');

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127230000', array['holded_operaciones, tipo operacion, peticiones en holded_acciones_items, CONFIRMAR, políticas por operación, cupo 50, holded-acciones-purgar'],
          'Holded: operaciones genéricas con aprobación (crm/supabase-holded-operaciones.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 9C (verificación, solo lectura) — Lo esperado:
--   operaciones en el catálogo: 232 (alto/normal: 119/113)
--   EXECUTE authenticated crear_operacion/purgar: no/no
--   EXECUTE authenticated aprobar(3)/peticiones/política: sí/sí/sí
--   aprobar(uuid, integer) antiguo: no existe
--   cupos con 0: 0          items: los mismos que en 9A
--   tarea holded-acciones-purgar: 1
--   migración registrada: 20261127230000 ...
-- ============================================================
select 'operaciones en el catálogo' as comprobacion,
       (select count(*) from public.holded_operaciones)::text || ' (alto/normal: ' ||
       (select count(*) from public.holded_operaciones where riesgo = 'alto')::text || '/' ||
       (select count(*) from public.holded_operaciones where riesgo = 'normal')::text || ')' as valor
union all
select 'EXECUTE authenticated crear_operacion/purgar',
       (case when has_function_privilege('authenticated', 'public.holded_acciones_crear_operacion(uuid, text, uuid, text, text, jsonb, jsonb, text[], jsonb, integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_purgar()', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE authenticated aprobar(3)/peticiones/política',
       (case when has_function_privilege('authenticated', 'public.holded_acciones_aprobar(uuid, integer, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_peticiones(uuid, integer, integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_cambiar_politica(uuid, text, text, integer, numeric)', 'execute') then 'sí' else 'no' end)
union all
select 'aprobar(uuid, integer) antiguo',
       case when to_regprocedure('public.holded_acciones_aprobar(uuid, integer)') is null then 'no existe' else 'EXISTE' end
union all
select 'cupos con 0', count(*)::text from public.holded_conexiones where cupo_acciones_mensual = 0
union all
select 'items', count(*)::text from public.holded_acciones_items
union all
select 'tarea holded-acciones-purgar', count(*)::text from cron.job where jobname = 'holded-acciones-purgar'
union all
select 'migración registrada', coalesce((select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261127230000'), 'NO');
