'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import OverlayRoot from '@/components/ui/shell/OverlayRoot';
import { useViewStore } from '@/lib/store';
import type { Project } from '@/lib/types';

/**
 * The viewer, for one project.
 *
 * This is the page that used to be `/`, unchanged in behaviour. What it gained
 * is a project: the bbox the scene is framed on, the name the status bar
 * reports, and the slug every fetch is scoped by.
 *
 * The whole Cesium tree is client-only: Cesium touches `window` at module
 * evaluation time, so server rendering it is not merely wasteful, it throws.
 *
 * The chrome's arrangement lives in OverlayRoot, which picks one of three
 * layouts for the viewport. It is deliberately NOT inlined here: the choice is
 * made in JavaScript so that exactly one instance of every control exists at a
 * time -- see the note at the top of that file for why duplicating the tree
 * behind CSS breakpoints would silently break the acceptance harness.
 */
const Scene = dynamic(() => import('@/components/globe/Scene'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center bg-bg">
      <span className="text-sm text-muted">Initialising globe…</span>
    </div>
  ),
});

export default function ProjectViewer({ project }: { project: Project }) {
  /**
   * The single write of `projectSlug` (and of `project`), and the only one
   * anywhere.
   *
   * In a useState initialiser rather than an effect, because it has to land
   * BEFORE any child mounts: effects run child-first, so CesiumRoot's mount
   * effect -- which is what issues the data fetches -- would run against a
   * null slug and then be told the right one afterwards. Children also take
   * the project as a prop, so nothing actually depends on the ordering; this
   * exists so that a component deep in the chrome can ask which project it is
   * looking at without seven layers of prop drilling.
   *
   * React may invoke a useState initialiser twice under StrictMode. Writing
   * the same slug twice is idempotent, and there is no other writer, so
   * "written once on mount and never mutated" holds.
   */
  useState(() => {
    useViewStore.setState({ projectSlug: project.slug, project });
    return null;
  });

  return (
    // h-dvh, not h-screen: on a phone `100vh` is the height the viewport would
    // have with the browser chrome retracted, so the status bar sits under the
    // address bar until the user scrolls -- which they cannot, because the page
    // does not scroll.
    <main className="relative h-dvh w-screen overflow-hidden">
      <Scene project={project} />
      <OverlayRoot />
    </main>
  );
}
