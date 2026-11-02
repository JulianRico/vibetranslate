/**
 * glossary.js - Glosario del usuario y compatibilidad con el glosario antiguo
 *
 * Los términos técnicos viven ahora en local-ai/tech-terms.js (más de 300, con cómo los escribe el reconocedor).
 * Aquí queda lo que el usuario añade por su cuenta («cómo se oye» → «cómo se escribe»: nombres de su equipo, siglas
 * propias) y la limpieza de configuraciones antiguas, que guardaban una copia entera del glosario de fábrica.
 */

const { createTechGlossary } = require('./local-ai/tech-glossary');

// Glosario de fábrica de las versiones anteriores. Cada vez que se guardaba la configuración se copiaba entero en
// settings.json como si fuera del usuario, así que entradas como 'real' → 'React' seguían aplicándose aunque se
// quitaran del código. Lo que coincida con esto no es del usuario y se descarta al cargar.
const LEGACY_GLOSSARY = {
  'cherpoy': 'SharePoint', 'sharepo': 'SharePoint', 'cherpoint': 'SharePoint', 'sherpoint': 'SharePoint',
  'es pe ef equis': 'SPFx', 'es pe f equis': 'SPFx', 'spfx': 'SPFx', 'pe en pe': 'PnP', 'pnp': 'PnP',
  'conec pe en pe': 'Connect-PnPOnline', 'conect pnp': 'Connect-PnPOnline', 'get pe en pe list': 'Get-PnPList',
  'get pnp list': 'Get-PnPList', 'get pe en pe site': 'Get-PnPSite', 'get pnp site': 'Get-PnPSite',
  'cmdlet': 'Cmdlet', 'camlet': 'Cmdlet', 'cumlet': 'Cmdlet', 'pauwer otomayt': 'Power Automate',
  'power automate': 'Power Automate', 'power aps': 'Power Apps', 'pauwer aps': 'Power Apps', 'm 3 6 5': 'Microsoft 365',
  'entra id': 'Microsoft Entra ID', 'graf api': 'Microsoft Graph API', 'ria': 'React', 'real': 'React', 'riac': 'React',
  'riact': 'React', 'taipscrip': 'TypeScript', 'taips crip': 'TypeScript', 'fluter': 'Flutter', 'nod': 'Node.js',
  'nodo': 'Node.js', 'node': 'Node.js', 'nes j s': 'Next.js', 'nextjs': 'Next.js', 'vats': 'Vite', 'vait': 'Vite',
  'angular': 'Angular', 'yeison': 'JSON', 'jason': 'JSON', 'res api': 'REST API', 'doker': 'Docker', 'doquer': 'Docker',
  'piton': 'Python', 'paiton': 'Python', 'a doble u ese': 'AWS', 'a doble v ese': 'AWS', 'asur': 'Azure',
  'gihub': 'GitHub', 'llithub': 'GitHub', 'kubernets': 'Kubernetes', 'guberne': 'Kubernetes', 'paip lain': 'Pipeline',
  'paiplain': 'Pipeline'
};

/** Solo las entradas que añadió el usuario: sin copias del glosario de fábrica antiguo ni valores vacíos. */
function userGlossary(saved) {
  const own = {};
  for (const [heard, correct] of Object.entries(saved || {})) {
    if (!heard || !String(heard).trim() || !correct || !String(correct).trim()) continue;
    if (LEGACY_GLOSSARY[heard] === correct) continue;
    own[heard] = correct;
  }
  return own;
}

/** Corrige términos técnicos con formas exactas (sin aproximaciones): para textos que no vienen del motor local. */
function applyTechnicalGlossary(text, customGlossary = {}, lang = 'es') {
  if (!text) return '';
  return createTechGlossary({ user: userGlossary(customGlossary), fuzzy: false }).correct(text, lang).text;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LEGACY_GLOSSARY, userGlossary, applyTechnicalGlossary };
}
