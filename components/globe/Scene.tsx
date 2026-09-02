'use client';

import CesiumRoot from './CesiumRoot';
import CameraDirector from './CameraDirector';
import Picker from './Picker';
import ParcelsLayer from '../layers/ParcelsLayer';
import BuildingsLayer from '../layers/BuildingsLayer';
import BuildingModelLayer from '../layers/BuildingModelLayer';
import FloorStackLayer from '../layers/FloorStackLayer';
import UnitsLayer from '../layers/UnitsLayer';
import UtilitiesLayer from '../layers/UtilitiesLayer';
import ConflictLayer from '../layers/ConflictLayer';
import ElevationRuler from '../ui/ElevationRuler';
import BuildingTooltip from './BuildingTooltip';

/**
 * The single Cesium scene. Every view mode is a state of this one scene --
 * there is no page navigation between city, building, floor and unit.
 *
 * Children only mount once CesiumRoot reports the viewer is ready, so no layer
 * has to defend against a null viewer on first render.
 */
export default function Scene() {
  return (
    <CesiumRoot>
      {/* Owns all camera motion. */}
      <CameraDirector />
      {/* Owns all picking; writes to the store. */}
      <Picker />

      {/* Render-only layers, drawn back to front. */}
      <ParcelsLayer />
      <BuildingsLayer />
      <BuildingModelLayer />
      <FloorStackLayer />
      <UnitsLayer />
      <UtilitiesLayer />
      <ConflictLayer />

      {/* DOM overlays that track the scene rather than the page layout. */}
      <ElevationRuler />
      <BuildingTooltip />
    </CesiumRoot>
  );
}
