// A tiny sample file for exercising the Pi agent in the Extension Development Host.

export function greet(name: string): string {
  // TODO: support localized greetings
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b; // TODO: guard against overflow for very large inputs
}

export function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "-");
}
