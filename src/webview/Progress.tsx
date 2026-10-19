/** The thin bar that runs while something loads, as in VS Code's own views. `page` puts it along the top of an editor tab. */
export function Progress({ label, page = false }: { label: string; page?: boolean }) {
  return (
    <div className={page ? 'progress page' : 'progress'} role="progressbar" aria-label={label}>
      <div className="bit" />
    </div>
  );
}
