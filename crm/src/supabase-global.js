// Recrea el global window.supabase (antes lo daba el <script> UMD de unpkg)
// para que crm/auth.js (sin convertir a módulo) siga funcionando sin tocarlo.
import { createClient } from "@supabase/supabase-js";
window.supabase = { createClient };
