'use strict';

/**
 * Seeder: ASAP projects (grant codes). The 2-letter code is what appears as
 * the prefix of a manuscript ID and is stored on submissions as `project`.
 * This reference table powers the dashboard's project filter and validates
 * the extracted project code. PI names / titles are public ASAP grant info.
 *
 * Note: the code `AS` is shared by two grants in the source list (Schapira and
 * Singleton); only one row can exist per code, so Schapira is kept here.
 */

const projects = [
  { code: 'WH', pi_name: 'J. Wade Harper', title: 'MECHANISMS OVERWHELMING PROTEIN AND ORGANELLE QUALITY CONTROL IN PARKINSON’S DISEASE' },
  { code: 'CS', pi_name: 'Clemens Scherzer', title: 'Parkinson5D: deconstructing proximal disease mechanisms across cells, space, and progression' },
  { code: 'XC', pi_name: 'Xiqun Chen', title: 'From cancer associations to altered immunity in the pathogenesis of Parkinson’s disease' },
  { code: 'HU', pi_name: 'James Hurley', title: 'Mechanisms of mitochondrial damage control by PINK1 and Parkin' },
  { code: 'DS', pi_name: 'David Sulzer', title: 'Adaptive immunity in the etiology and progression of Parkinson’s disease' },
  { code: 'AS', pi_name: 'Anthony Schapira', title: 'The genome-microbiome axis in the cause of Parkinson disease: Mechanistic insights and therapeutic implications from experimental models and a genetically stratified patient population.' },
  { code: 'TV', pi_name: 'Thierry Voet', title: 'Understanding inherited and acquired genetic variation in Parkinson’s disease through single-cell multi-omics analyses: a unique data resource' },
  { code: 'PV', pi_name: 'Peter Vangheluwe', title: 'Implications of Polyamine and Glucosylceramide Transport for Parkinson’s Disease (IMPACT-PD)' },
  { code: 'DA', pi_name: 'Dario Alessi', title: 'Mapping the LRRK2 signalling pathway and its interplay with other Parkinson’s disease components' },
  { code: 'LS', pi_name: 'Lorenz Studer', title: 'Defining the cellular and molecular determinants of variable genetic penetrance in Parkinson’s disease' },
  { code: 'JH', pi_name: 'John Hardy', title: 'Dissecting the mechanisms underlying disease progression in parkinsonism' },
  { code: 'DR', pi_name: 'Donald Rio', title: 'Dissecting genetic interactions of Parkinson’s disease associated risk loci' },
  { code: 'DK', pi_name: 'Deniz Kirik', title: 'An in vivo approach to elucidate the pathobiology of PD-associated genes using human diseased neurons' },
  { code: 'NW', pi_name: 'Nicholas Wood', title: 'Mapping the PD brain: Oligomer-driven functional genomics.' },
  { code: 'SR', pi_name: 'Samara Reck-Peterson', title: 'Cellular Mechanism of LRRK2 in Health and Disease' },
  { code: 'JJ', pi_name: 'Johan Jakobsson', title: 'Activation of transposable elements as a trigger of neuroinflammation in Parkinson’s disease' },
  { code: 'JK', pi_name: 'Jeffrey Kordower', title: 'Co-Pathologies Drive Neuroinflammation and Progression in PD' },
  { code: 'MD', pi_name: 'Michel Desjardins', title: 'The role of PD-related proteins as drivers of disease through modulation of innate and adaptive immunity' },
  { code: 'DH', pi_name: 'David Hafler', title: 'Tracing the Origin and Progression of Parkinson’s Disease through the Neuro-Immune Interactome' },
  { code: 'PD', pi_name: 'Pietro De Camilli', title: 'Impaired integration of organelle function in Parkinson’s disease' },
  { code: 'ML', pi_name: 'Michael Lee', title: 'Senescence in Parkinson’s disease and related disorders' },
  { code: 'MC', pi_name: 'Mark Cookson', title: 'Generate research-enabling tools to fuel PD mechanistic studies' },
  { code: 'SC', pi_name: 'Stephanie Cragg', title: 'Mapping the modulatory landscape governing striatal dopamine signaling and its dysregulation in Parkinson’s disease' },
  { code: 'VG', pi_name: 'Viviana Gradinaru', title: 'Gut-to-brain circuit contributions to Parkinson-like phenotypes in non-transgenic rodent and primate animal models' },
  { code: 'MV', pi_name: 'Miquel Vila', title: 'Activity and connectivity drive neuronal vulnerability and disease progression in Parkinson’s disease' },
  { code: 'PS', pi_name: 'Peter Strick', title: 'Basal Ganglia Networks in Parkinson’s Disease' },
  { code: 'RL', pi_name: 'Rodger Liddle', title: 'Role of enteroendocrine cells in the origin of Parkinson’s pathology' },
  { code: 'RE', pi_name: 'Robert Edwards', title: 'The Dual Role of Neural Activity in Parkinson\'s Disease' },
  { code: 'JS', pi_name: 'D. James Surmeier', title: 'Distributed circuit dysfunction underlying motor and sleep deficits in a progressive mouse model of Parkinson’s disease' },
  { code: 'XF', pi_name: 'Xiang-Dong Fu', title: 'Reconstructing the Lost Nigrostriatal Circuitry in Parkinson\'s Disease' },
  { code: 'TW', pi_name: 'Thomas Wichmann', title: 'Cortical pathophysiology of Parkinsonism' },
  { code: 'RA', pi_name: 'Rajeshwar Awatramani', title: 'Redefining PD pathophysiology mechanisms in the context of heterogeneous substantia nigra neuron subtypes' },
  { code: 'NC', pi_name: 'Nicole Calakos', title: 'Circuit Mechanisms for Dopamine Neuron Vulnerability and Resilience in PD' },
  { code: 'MK', pi_name: 'Michael Kaplitt', title: 'α-Synuclein Effects on Gut Brain Circuits and Pre-Motor Symptoms in Parkinson’s Disease' },
  { code: 'TB', pi_name: 'Thomas Biederer', title: 'Understanding and manipulating cellular and circuit-level vulnerability to neurodegeneration in Parkinson’s disease' },
  { code: 'MS', pi_name: 'Michael Schlossmacher', title: 'Olfactory Circuits: Alpha-Synuclein-Rich Neurons Respond to Environmental Triggers at the Origin of Parkinson Disease' },
  { code: 'KM', pi_name: 'Ken Marek', title: 'PPMI: Parkinson\'s Progression Marker\'s Initiative' }
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    // Upsert so PI/title are populated even if a project row already exists
    // (e.g. a code carried over from the old teams table by the migration).
    for (const p of projects) {
      await queryInterface.sequelize.query(
        `INSERT INTO "projects" ("code", "pi_name", "title", "active", "created_at", "updated_at")
         VALUES (:code, :pi, :title, true, :now, :now)
         ON CONFLICT ("code") DO UPDATE
           SET "pi_name" = EXCLUDED."pi_name",
               "title" = EXCLUDED."title",
               "updated_at" = EXCLUDED."updated_at"`,
        { replacements: { code: p.code, pi: p.pi_name, title: p.title, now } }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('projects', {
      code: projects.map(p => p.code)
    });
  }
};
