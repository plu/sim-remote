export function toast(text: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

export function setBadge(text: string, driving: boolean): void {
  const el = document.getElementById('badge');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('driving', driving);
}
