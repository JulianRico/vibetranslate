/**
 * glossary.js - Diccionario Maestro Técnico y Fonético
 * Modulo nativo para la app de escritorio Electron.
 */

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
  'ria': 'React',
  'real': 'React',
  'riac': 'React',
  'riact': 'React',
  'taipscrip': 'TypeScript',
  'taips crip': 'TypeScript',
  'fluter': 'Flutter',
  'nod': 'Node.js',
  'nodo': 'Node.js',
  'node': 'Node.js',
  'nes j s': 'Next.js',
  'nextjs': 'Next.js',
  'vats': 'Vite',
  'vait': 'Vite',
  'angular': 'Angular',
  'yeison': 'JSON',
  'jason': 'JSON',
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

function applyTechnicalGlossary(text, customGlossary = {}) {
  if (!text) return '';
  const combined = { ...DEFAULT_GLOSSARY, ...(customGlossary || {}) };
  let processed = text;

  for (const [misspelled, correct] of Object.entries(combined)) {
    const regex = new RegExp(`\\b${misspelled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    processed = processed.replace(regex, correct);
  }

  return processed;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_GLOSSARY, applyTechnicalGlossary };
}
