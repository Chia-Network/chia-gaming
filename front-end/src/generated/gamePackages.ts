// Generated from games/registry.json. Do not edit.
import handProposal0 from '../../../games/calpoker/ui/handProposal';
import { HandProposalForm as HandProposalForm0 } from '../../../games/calpoker/ui/handProposalForm';
import { play as play0 } from '../../../games/calpoker/ui/play';
const pkg0 = Object.assign({}, handProposal0, { HandProposalForm: HandProposalForm0, ...play0 });
import handProposal1 from '../../../games/spacepoker/ui/handProposal';
import { HandProposalForm as HandProposalForm1 } from '../../../games/spacepoker/ui/handProposalForm';
import { play as play1 } from '../../../games/spacepoker/ui/play';
const pkg1 = Object.assign({}, handProposal1, { HandProposalForm: HandProposalForm1, ...play1 });
import handProposal2 from '../../../games/krunk/ui/handProposal';
import { HandProposalForm as HandProposalForm2 } from '../../../games/krunk/ui/handProposalForm';
import { play as play2 } from '../../../games/krunk/ui/play';
const pkg2 = Object.assign({}, handProposal2, { HandProposalForm: HandProposalForm2, ...play2 });

export const PRODUCTION_PACKAGE_KEYS = ['calpoker', 'spacepoker', 'krunk'] as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const GENERATED_GAME_PACKAGES = [pkg0, pkg1, pkg2];
export { PRESET_FILES, GAME_PRESET_FILES, CORE_PRESET_FILES } from './gamePresets';
