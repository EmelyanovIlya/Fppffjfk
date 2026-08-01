export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Не найден элемент #${id}`);
  return node as T;
}

export const input = (id: string) => el<HTMLInputElement>(id);
export const select = (id: string) => el<HTMLSelectElement>(id);
export const button = (id: string) => el<HTMLButtonElement>(id);

export function num(id: string, fallback = 0): number {
  const value = Number.parseFloat(input(id).value);
  return Number.isFinite(value) ? value : fallback;
}

export function bool(id: string): boolean {
  return input(id).checked;
}

export function setText(id: string, text: string): void {
  el(id).textContent = text;
}

export function setHidden(id: string, hidden: boolean): void {
  el(id).hidden = hidden;
}

export function on<K extends keyof HTMLElementEventMap>(
  id: string,
  event: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  el(id).addEventListener(event, handler);
}

/** Откладывает частые события (ползунки) до следующего кадра. */
export function throttleFrame<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let pending = false;
  let latest: T;
  return (...args: T) => {
    latest = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...latest);
    });
  };
}
