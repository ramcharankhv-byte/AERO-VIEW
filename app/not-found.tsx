/**
 * An unknown project slug.
 *
 * Reached from app/p/[slug]/page.tsx's notFound() when nothing -- registry,
 * snapshot directory or PostGIS -- knows the slug. Distinct from the
 * "unavailable" panel that page renders itself, which is for a project that
 * really exists and cannot currently be served.
 */
export default function NotFound() {
  return (
    <main className="grid h-dvh w-screen place-items-center bg-bg px-4">
      <div className="glass max-w-md rounded-lg p-5">
        <p className="panel-title">Not found</p>
        <h1 className="mt-2 text-lg font-semibold text-ink">No such project</h1>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          Nothing is registered under that slug: there is no snapshot directory
          for it under <code className="font-mono text-ink">data/api/</code> and
          PostGIS has no rows for it either.
        </p>
        <a
          href="/"
          className="tint-hover mt-4 inline-block rounded border border-edge px-2 py-1 text-[11px] text-ink"
        >
          ← All projects
        </a>
      </div>
    </main>
  );
}
