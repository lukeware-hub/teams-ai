// Apply the saved theme before the first paint, so a dark choice never flashes light. Mirrors src/theme.ts.
try {
  var pref = localStorage.getItem('teams-ai.theme');
  var dark = pref === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : pref !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'dark';
}
