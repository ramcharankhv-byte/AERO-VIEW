'use client';

import CesiumRoot from './CesiumRoot';
import CameraDirector from './CameraDirector';
import Picker from './Picker';
import BhuvanOverlayLayer from '../layers/BhuvanOverlayLayer';
import HazardRiskLayer from '../layers/HazardRiskLayer';
import ParcelsLayer from '../layers/ParcelsLayer';
import SurveyParcelsLayer from '../layers/SurveyParcelsLayer';
import Section22ALayer from '../layers/Section22ALayer';
import BuildingsLayer from '../layers/BuildingsLayer';
import BuildingsFarLayer from '../layers/BuildingsFarLayer';
import RoadsLayer from '../layers/RoadsLayer';
import BuildingModelLayer from '../layers/BuildingModelLayer';
import FloorStackLayer from '../layers/FloorStackLayer';
import UnitsLayer from '../layers/UnitsLayer';
import UtilitiesLayer from '../layers/UtilitiesLayer';
import InfraSiteLayer from '../layers/InfraSiteLayer';
import TopologyLayer from '../layers/TopologyLayer';
import ElevationRuler from '../ui/ElevationRuler';
import BuildingTooltip from './BuildingTooltip';
import CitizenAutoFrame from '@/components/citizen/CitizenAutoFrame';
import type { Project } from '@/lib/types';

/**
 * The single Cesium scene. Every view mode is a state of this one scene --
 * there is no page navigation between city, building, floor and unit.
 *
 * Children only mount once CesiumRoot reports the viewer is ready, so no layer
 * has to defend against a null viewer on first render.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE 2D GIS VIEW HIDES, AND WHY IT IS NOT DONE HERE
 *
 * Every layer below stays MOUNTED when `gis2d` is on. Unmounting them would be
 * the obvious way to write it and the wrong one: it tears down and rebuilds
 * ~770 building entities on each toggle, which is a visible stall on a control
 * the user is expected to flick back and forth. So each layer instead gates
 * its own single visibility expression on `!gis2d`, which is a flag flip.
 *
 * The line between what is hidden and what is not is: ANYTHING DRAWN ABOVE THE
 * GROUND STANDS DOWN; anything DRAPED ON the ground stays under the user's
 * control.
 *
 *   hidden   Buildings (and the far, edge and model tiers of them), the floor
 *            stack, the units, the utilities, the streets, and the
 *            infrastructure site -- all of them solids, and there is no
 *            honest way to draw a solid on a plan.
 *   hidden   ParcelsLayer, which is the exception to the rule: it is draped,
 *            but SurveyParcelsLayer replaces it here. Two parcel layers drawn
 *            together would be two different derivations of the same plots, in
 *            the same ink, on the same ground, with no way for a reader to
 *            tell which boundary was which.
 *   kept     The Bhuvan land-use and hazard overlays and the derived hazard
 *            grading. They are ground-draped raster context, they are off
 *            unless the user asked for them, and land use underneath parcel
 *            boundaries is what a GIS is FOR. Turning off a layer someone
 *            deliberately enabled would be this view overruling them.
 *   kept     Section22ALayer, for exactly those reasons: draped, opt-in, and
 *            restricted land over a cadastral sheet is the reading the 2D view
 *            is best at. It draws over BOTH parcel layers, which is why it is
 *            mounted after them.
 *
 * The floor stack and the units need no gate of their own: entering the mode
 * drops `mode` to 'city' and forces `slice.enabled` false, and both layers are
 * already inert in that state.
 */
export default function Scene({ project }: { project: Project }) {
  return (
    <CesiumRoot project={project}>
      {/* Owns all camera motion. */}
      <CameraDirector />
      {/* Owns all picking; writes to the store. */}
      <Picker />
      {/* Citizen view: on a citizen session, snap to the user's building +
         their floor, with their flat selected. Renders nothing for gov. */}
      <CitizenAutoFrame />

      {/* Render-only layers, drawn back to front. */}
      {/* ISRO Bhuvan WMS overlays on the globe, above the basemap. */}
      <BhuvanOverlayLayer />
      {/* The derived local grading painted on the ground, under the buildings. */}
      <HazardRiskLayer />
      <ParcelsLayer />
      {/* The 2D cadastral layer. Draws nothing, and fetches nothing, until
         the 2D GIS view is opened. */}
      <SurveyParcelsLayer />
      {/* Section 22A restricted lands, over both parcel layers. Draws nothing,
         and fetches nothing, until the 22A toggle is first pressed. */}
      <Section22ALayer />
      <RoadsLayer />
      <BuildingsLayer />
      <BuildingsFarLayer />
      <BuildingModelLayer />
      <FloorStackLayer />
      <UnitsLayer />
      <UtilitiesLayer />
      {/* The active named structure. Builds nothing until a site is opened. */}
      <InfraSiteLayer />
      <TopologyLayer />

      {/* DOM overlays that track the scene rather than the page layout. */}
      <ElevationRuler />
      <BuildingTooltip />
    </CesiumRoot>
  );
}
