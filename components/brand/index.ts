/**
 * SCOLAIRA brand surface — the single import path for every brand mark.
 *
 *   import { ScolairaSymbol, ScolairaLockup } from '@/components/brand';
 *
 * Importing from anywhere else (`./scolaira-mark`, a copy, an inline SVG) is how a
 * brand forks. Everything ships through this barrel.
 */
export {
  ScolairaSymbol,
  ScolairaSymbolSmall,
  ScolairaIcon,
  ScolairaWordmark,
  ScolairaLockup,
  SCOLAIRA_DESCRIPTOR,
} from './scolaira-mark';
export type {
  MarkTone,
  ScolairaSymbolProps,
  ScolairaWordmarkProps,
  ScolairaLockupProps,
} from './scolaira-mark';
