/**
 * One label change, drawn the same way whichever direction it goes (#426).
 *
 * ## Removals are not the quiet half
 *
 * #426: *"a reply saying 'sure, I've set those three to ready!' while hiding
 * seventeen removals in a sentence is worse than no chat at all"*. The
 * defence against that is structural rather than editorial: additions and
 * removals are drawn by the SAME component, at the same size, in the same
 * variant, with the same weight of text, and the only difference between them
 * is the colour and the verb. There is no prop here that could make one
 * smaller than the other, and nothing renders a removal into a tooltip, a
 * title attribute, an aria-label or a collapsed section.
 *
 * Removals are rendered FIRST for the same reason. A row that begins with what
 * it takes away is read that way even by somebody scanning.
 */

import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Chip, Stack } from '@mui/material';

/** Size and variant are stated once, for both directions, on purpose. */
const CHIP_SIZE = 'medium' as const;
const CHIP_VARIANT = 'filled' as const;

export function LabelChangeChip({
  direction,
  label,
}: {
  direction: 'add' | 'remove';
  label: string;
}) {
  const removing = direction === 'remove';

  return (
    <Chip
      size={CHIP_SIZE}
      variant={CHIP_VARIANT}
      color={removing ? 'warning' : 'success'}
      icon={removing ? <RemoveIcon /> : <AddIcon />}
      // The verb is in the visible text rather than only in the colour: a
      // colour is not readable by everyone and is not readable at all in a
      // screen reader.
      label={`${removing ? 'Removes' : 'Adds'} ${label}`}
      data-testid={`label-${direction}`}
    />
  );
}

export function LabelDiff({
  add,
  remove,
}: {
  add: readonly string[];
  remove: readonly string[];
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ mt: 0.75, mb: 0.5, flexWrap: 'wrap' }}
    >
      {remove.map((label) => (
        <LabelChangeChip
          key={`remove-${label}`}
          direction="remove"
          label={label}
        />
      ))}
      {add.map((label) => (
        <LabelChangeChip key={`add-${label}`} direction="add" label={label} />
      ))}
    </Stack>
  );
}
