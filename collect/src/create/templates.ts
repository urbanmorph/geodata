// Starting points for "Make a new map": what is being mapped presets what
// people mark and the questions they answer. Every question can be changed in
// step 3; these are drafts to edit, not rules.
import type { BuilderField } from '../schema-builder';

export interface Template {
  id: string;
  title: string;
  blurb: string;
  geometry: string[];
  category: string;
  name: string;    // placeholder for the map's name
  purpose: string; // placeholder for what people should do
  fields: BuilderField[];
}

const photo = (label: string, hint: string, max_photos = 3): BuilderField => ({ key: 'photo', label, type: 'photo', max_photos, hint });
const notes: BuilderField = { key: 'notes', label: 'Anything else?', type: 'paragraph' };

export const TEMPLATES: Template[] = [
  {
    id: 'footpaths', title: 'Footpaths and walking', blurb: 'Footpaths, crossings and what gets in the way',
    geometry: ['line', 'point'], category: 'transport',
    name: 'Footpaths around Mount Carmel', purpose: 'Walk the streets and mark each stretch of footpath and every crossing',
    fields: [
      { key: 'condition', label: 'What condition is it in?', type: 'select', render: 'chips', required: true, options: ['Good', 'Uneven', 'Broken', 'Blocked', 'No footpath'] },
      { key: 'problems', label: 'What gets in the way?', type: 'multiselect', options: ['Broken slabs', 'Open drain', 'Encroached', 'Parked vehicles', 'Garbage', 'No ramp', 'Poor lighting'] },
      { key: 'width_m', label: 'Width in metres', type: 'number', min: 0, max: 20, hint: 'Pace it out if you have no tape' },
      photo('Photo', 'Show the footpath, not the people on it'),
      notes,
    ],
  },
  {
    id: 'trees', title: 'Trees', blurb: 'Street and park trees and their health',
    geometry: ['point'], category: 'environment',
    name: 'Trees of our ward', purpose: 'Stand by each tree and add it, with a photo',
    fields: [
      { key: 'tree', label: 'Which tree is it?', type: 'text', hint: 'The common name, if you know it' },
      { key: 'health', label: 'How healthy is it?', type: 'select', render: 'chips', required: true, options: ['Healthy', 'Needs care', 'Dead or dying'] },
      { key: 'girth_cm', label: 'Trunk round, in cm', type: 'number', integer: true, min: 0, hint: 'Measure around the trunk at chest height' },
      photo('Photo of the tree', 'Step back so the whole tree shows'),
      notes,
    ],
  },
  {
    id: 'farms', title: 'Farms and fields', blurb: 'Whole fields: walk the boundary, add photos',
    geometry: ['polygon'], category: 'agriculture',
    name: 'Fields of Hosahalli', purpose: 'Walk around each field, then take photos from different sides',
    fields: [
      { key: 'crop', label: 'What is growing?', type: 'select', required: true, options: ['Paddy', 'Ragi', 'Maize', 'Sugarcane', 'Pulses', 'Vegetables', 'Fruit trees', 'Fallow', 'Other'] },
      { key: 'water', label: 'Where does the water come from?', type: 'select', render: 'chips', options: ['Rain-fed', 'Borewell', 'Canal', 'Tank', 'Other'] },
      { key: 'season', label: 'Season', type: 'select', render: 'chips', options: ['Kharif', 'Rabi', 'Summer', 'All year'] },
      photo('Photos of the field', 'From different corners'),
      notes,
    ],
  },
  {
    id: 'garbage', title: 'Garbage spots', blurb: 'Dumps and black spots, to get them cleared',
    geometry: ['point'], category: 'environment',
    name: 'Garbage spots in Ward 12', purpose: 'Photograph every garbage spot you pass',
    fields: [
      photo('Photo of the spot', 'Stand back so the whole heap shows'),
      { key: 'kind', label: 'What kind of waste?', type: 'multiselect', options: ['Household', 'Plastic', 'Construction debris', 'Garden waste', 'Being burnt'] },
      { key: 'size', label: 'How big is it?', type: 'select', render: 'chips', options: ['A bag or two', 'A cartload', 'A truckload'] },
      notes,
    ],
  },
  {
    id: 'other', title: 'Something else', blurb: 'Start with a name and a photo, add your own questions',
    geometry: ['point'], category: 'other',
    name: 'Water taps in our village', purpose: 'Add each one you find',
    fields: [
      { key: 'name', label: 'What is it called?', type: 'text', required: true },
      photo('Photo', 'Keep faces and number plates out of the frame'),
      notes,
    ],
  },
];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);
