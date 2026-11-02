/**
 * glossary.js - Diccionario Maestro Técnico y Fonético
 * Modulo nativo para la app de escritorio Electron.
 */

// Solo deformaciones que no son palabras corrientes: el glosario se aplica a todo lo que se traduce, en inglés
// y en español, y una entrada como 'real' → 'React' convertía «a real AI lab» en «a React AI lab».
const DEFAULT_GLOSSARY = {
  // SharePoint & M365
  'cherpoy': 'SharePoint',
  'sharepo': 'SharePoint',
  'cherpoint': 'SharePoint',
  'sherpoint': 'SharePoint',
  'es pe ef equis': 'SPFx',
  'es pe f equis': 'SPFx',
  'spfx': 'SPFx',
  'pe en pe': 'PnP',
  'pnp': 'PnP',
  'conec pe en pe': 'Connect-PnPOnline',
  'conect pnp': 'Connect-PnPOnline',
  'get pe en pe list': 'Get-PnPList',
  'get pnp list': 'Get-PnPList',
  'get pe en pe site': 'Get-PnPSite',
  'get pnp site': 'Get-PnPSite',
  'cmdlet': 'Cmdlet',
  'camlet': 'Cmdlet',
  'cumlet': 'Cmdlet',
  'pauwer otomayt': 'Power Automate',
  'power automate': 'Power Automate',
  'power aps': 'Power Apps',
  'pauwer aps': 'Power Apps',
  'm 3 6 5': 'Microsoft 365',
  'entra id': 'Microsoft Entra ID',
  'graf api': 'Microsoft Graph API',

  // Desarrollo Web & Frontend
  'riac': 'React',
  'riact': 'React',
  'taipscrip': 'TypeScript',
  'taips crip': 'TypeScript',
  'fluter': 'Flutter',
  'nes j s': 'Next.js',
  'nextjs': 'Next.js',
  'vait': 'Vite',
  'angular': 'Angular',
  'yeison': 'JSON',
  'res api': 'REST API',

  // Cloud & DevOps
  'doker': 'Docker',
  'doquer': 'Docker',
  'piton': 'Python',
  'paiton': 'Python',
  'a doble u ese': 'AWS',
  'a doble v ese': 'AWS',
  'asur': 'Azure',
  'gihub': 'GitHub',
  'llithub': 'GitHub',
  'kubernets': 'Kubernetes',
  'guberne': 'Kubernetes',
  'paip lain': 'Pipeline',
  'paiplain': 'Pipeline'
};

/** Corrige términos técnicos mal transcritos en una sola pasada: lo ya reemplazado no se vuelve a reemplazar. */
function applyTechnicalGlossary(text, customGlossary = {}) {
  if (!text) return '';
  const combined = {};
  for (const [misspelled, correct] of Object.entries({ ...DEFAULT_GLOSSARY, ...(customGlossary || {}) })) {
    if (misspelled && misspelled.trim()) combined[misspelled.trim().toLowerCase()] = correct;
  }
  const keys = Object.keys(combined).sort((a, b) => b.length - a.length); // la forma más larga gana
  if (keys.length === 0) return text;
  const alternatives = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Límites de palabra que entienden tildes y eñes (\b no: trata «á» como separador)
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(pattern, (match) => combined[match.toLowerCase()] ?? match);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_GLOSSARY, applyTechnicalGlossary };
}
