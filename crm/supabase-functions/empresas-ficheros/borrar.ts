// Borra de Storage los ficheros de las empresas eliminadas
// (public.storage_borrados, crm/supabase-empresas-borrar.sql). Separado de
// index.ts para probarlo con clientes simulados (borrar_test.ts).

export const LOTE = 100; // rutas por llamada a remove()

// Lo mínimo que se usa del cliente de Supabase con la service role.
export type Admin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  storage: { from(bucket: string): { remove(rutas: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
};

// Intenta borrar todo lo pendiente (de un lote o de todos). Lo que falla se
// queda pendiente con su error; lo que no existía ya en Storage cuenta como
// borrado (remove() no da error por eso).
export async function borrarPendientes(admin: Admin, lote: string | null, limite = 1000) {
  const { data, error } = await admin.rpc("storage_borrados_pendientes", { p_lote: lote, p_limite: limite });
  if (error) throw new Error(error.message);
  const rutas = ((data || []) as { ruta: string }[]).map((r) => r.ruta).filter((r) => typeof r === "string" && r.length > 0);
  let borrados = 0, errores = 0;
  for (let i = 0; i < rutas.length; i += LOTE) {
    const parte = rutas.slice(i, i + LOTE);
    let fallo: string | null = null;
    try {
      const { error: rmErr } = await admin.storage.from("documentos").remove(parte);
      if (rmErr) fallo = rmErr.message || "Error de Storage";
    } catch (e) {
      fallo = e instanceof Error ? e.message : String(e);
    }
    const { error: resErr } = await admin.rpc("storage_borrados_resultado", { p_rutas: parte, p_error: fallo });
    if (resErr) throw new Error(resErr.message);
    if (fallo) errores += parte.length; else borrados += parte.length;
  }
  return { encontrados: rutas.length, borrados, errores };
}
