export function Icon({ name, spin }: { name: string; spin?: boolean }) {
  return <i className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />;
}
