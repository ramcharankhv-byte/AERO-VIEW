/**
 * Name banks for the synthetic building register.
 *
 * Curated for Visakhapatnam specifically rather than generically "Indian":
 * the prefixes are the temples, hills and rivers this city actually names
 * buildings after (Simhachalam, Rushikonda, Kailasagiri, Jagadamba), and the
 * institutional owners are the bodies that really hold property in Siripuram
 * (GVMC, VMRDA, APEPDCL, the Andhra University estate). A generic bank would
 * have produced names that read as filler, which is exactly what the brief
 * rules out.
 *
 * None of this is a real register. See BuildingMock in lib/types.ts.
 */

export const PREFIX = [
  'Sai', 'Sri', 'Lakshmi', 'Gayatri', 'Vasavi', 'Annapurna', 'Simhachalam',
  'Kailash', 'Aditya', 'Sarada', 'Rama', 'Vinayaka', 'Padmavathi', 'Chaitanya',
  'Bhavani', 'Nagendra', 'Yamuna', 'Tejaswi', 'Suryodaya', 'Krishnaveni',
  'Kanaka', 'Dwaraka', 'Sagar', 'Jagadamba', 'Rushikonda', 'Kailasagiri',
  'Bheemili', 'Venkateswara', 'Ushodaya', 'Sankalp',
] as const;

export const RESIDENTIAL_SUFFIX = [
  'Residency', 'Enclave', 'Apartments', 'Nivas', 'Heights', 'Towers',
  'Gardens', 'Homes', 'Grand', 'Castle', 'Nilayam', 'Estate',
] as const;

export const COMMERCIAL_SUFFIX = [
  'Chambers', 'Plaza', 'Arcade', 'Complex', 'Trade Centre', 'Business Park',
  'Emporium', 'Tower', 'Square', 'Point',
] as const;

export const INSTITUTIONAL_SUFFIX = [
  'Vidya Niketan', 'Public School', 'Junior College', 'Community Hall',
  'Health Centre', 'Trust Building', 'Study Centre', 'Block', 'Bhavan',
] as const;

export const INDUSTRIAL_SUFFIX = [
  'Works', 'Godown', 'Industrial Shed', 'Depot', 'Unit', 'Yard',
] as const;

export const SURNAME = [
  'Raju', 'Naidu', 'Rao', 'Varma', 'Reddy', 'Sastry', 'Prasad', 'Murthy',
  'Chowdary', 'Apparao', 'Sarma', 'Patnaik',
] as const;

/** Bodies that hold property in this AOI in real life. */
export const PUBLIC_OWNER = [
  'GVMC',
  'VMRDA',
  'APEPDCL',
  'Andhra University Estate Office',
  'Visakhapatnam Port Authority',
  'AP Housing Board',
  'GVMC Town Planning',
  'AP State Road Transport Corporation',
] as const;

/**
 * Building subtypes, keyed by the REAL use_type and constrained by the REAL
 * floor count.
 *
 * The generator only ever picks among options the sourced data already
 * permits, so a fabricated subtype can never contradict a surveyed number --
 * a two-storey building will not be labelled an apartment tower.
 */
export function subtypesFor(useType: string, floors: number): readonly string[] {
  switch (useType) {
    case 'residential':
      if (floors >= 8) return ['Apartment tower', 'High-rise residential'];
      if (floors >= 4) return ['Apartment block', 'Residential block'];
      if (floors >= 2) return ['Row house', 'Independent house', 'Duplex'];
      return ['Independent house'];
    case 'commercial':
      if (floors >= 6) return ['Office tower', 'Corporate block'];
      if (floors >= 3) return ['Office block', 'Retail & office'];
      return ['Retail', 'Showroom', 'Restaurant'];
    case 'institutional':
      return [
        'Academic block', 'Administrative block', 'Library', 'Laboratory',
        'Auditorium', 'School', 'Hostel block',
      ];
    case 'industrial':
    default:
      return ['Workshop', 'Godown', 'Utility building', 'Service depot'];
  }
}

export function suffixesFor(useType: string): readonly string[] {
  switch (useType) {
    case 'commercial': return COMMERCIAL_SUFFIX;
    case 'institutional': return INSTITUTIONAL_SUFFIX;
    case 'industrial': return INDUSTRIAL_SUFFIX;
    case 'residential':
    default: return RESIDENTIAL_SUFFIX;
  }
}
