// Punto de entrada único del bundle de Vite. Sustituye a los <script> de
// unpkg (React, ReactDOM, Babel, supabase-js) y a la transpilación de
// ui.jsx/app.jsx en el navegador. El orden de los imports importa: cada
// fichero de abajo depende de los globales que fija el anterior, exactamente
// igual que el orden de <script> que había antes en crm.html.
import "./supabase-global.js"; // window.supabase (antes lo daba el <script> UMD)
import "../data.js";           // window.CRM
import "../config.js";         // window.SUPABASE_CONFIG
import "../auth.js";           // window.Auth (usa window.supabase + window.SUPABASE_CONFIG)
import "../ui.jsx";            // window.Icon, window.Modal, etc. (usa window.CRM)
import { mountApp } from "../app.jsx"; // usa window.CRM/window.Auth/los globales de ui.jsx

mountApp();
