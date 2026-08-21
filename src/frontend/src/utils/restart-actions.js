/**
 * How each pipeline step is restarted.
 *
 * One map, shared, because there are now two places a person can ask for a
 * restart — the processes panel and a module's own results page — and two
 * copies of a service-per-step table is two chances for a step to be
 * restartable in one place and silently not in the other.
 *
 * The SERVER decides what actually happens: a restart asked for while the step
 * is already in flight is deliberately a no-op, and the reply says "… is already
 * running" rather than "… queued". Callers show what the server said and fall
 * back to their own wording only if it said nothing.
 */

import pdfService from '@/services/pdf.service'
import softwareService from '@/services/software.service'
import orcidService from '@/services/orcid.service'
import datasetsService from '@/services/datasets.service'
import materialsService from '@/services/materials.service'
import protocolsService from '@/services/protocols.service'
import identifierDetectionService from '@/services/identifier-detection.service'
import krtGroundingService from '@/services/krt-grounding.service'
import markdownService from '@/services/markdown.service'
import suggestionService from '@/services/suggestion.service'
import dasSuggestionsService from '@/services/das-suggestions.service'

/** jobType → [trigger, human label]. */
export const RESTART_ACTIONS = {
  das_extraction: [(id) => pdfService.extractDAS(id), 'DAS extraction'],
  pdf_analysis: [(id) => pdfService.triggerAnalysis(id), 'PDF analysis'],
  software_detection: [(id) => softwareService.triggerDetection(id), 'Software detection'],
  orcid_extraction: [(id) => orcidService.triggerExtraction(id), 'ORCID extraction'],
  markdown_convert: [(id) => markdownService.triggerConvert(id), 'Markdown conversion'],
  datasets_detection: [(id) => datasetsService.triggerDetection(id), 'Datasets detection'],
  materials_detection: [(id) => materialsService.triggerDetection(id), 'Materials detection'],
  protocols_detection: [(id) => protocolsService.triggerDetection(id), 'Protocols detection'],
  identifier_detection: [(id) => identifierDetectionService.triggerDetection(id), 'Identifier detection'],
  krt_grounding: [(id) => krtGroundingService.triggerGrounding(id), 'KRT grounding'],
  suggestion_generation: [(id) => suggestionService.regenerate(id), 'AI suggestion generation'],
  das_suggestions: [(id) => dasSuggestionsService.regenerate(id), 'Availability Statement check']
}

/** Whether this step can be restarted at all. */
export const canRestartType = (jobType) => !!RESTART_ACTIONS[jobType]
