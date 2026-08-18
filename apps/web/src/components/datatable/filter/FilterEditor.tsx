/**
 * DataTable — the add-a-filter form.
 *
 * Three controls in a row (or stacked, on a phone): **column → operator →
 * value**, plus an Add button. The same component serves every layout; only
 * `orientation` changes.
 *
 * ## Why the draft is local and only committed filters are emitted
 *
 * The form owns an incomplete `DataTableFilter` — the user has picked a column
 * but not yet typed a value. That draft is NEVER emitted: `onCommit` fires once
 * `isFilterComplete()` holds. If a half-built filter reached the page, the very
 * first click of "Add filter" would trigger a refetch with a meaningless param,
 * and every keystroke after it another one. The chip strip and the emitted
 * model therefore always describe a real, applied query.
 *
 * ## Value control by declared type
 *
 * | `filterType` | operand control                                    |
 * | ------------ | -------------------------------------------------- |
 * | `text`       | text field                                         |
 * | `number`     | number field (two, for `between`)                  |
 * | `date`       | native date field (two, for `between`)             |
 * | `enum`       | select over `enumValues`; multi-select for `isAnyOf`|
 * | `boolean`    | Yes / No select                                    |
 *
 * A 0-arity operator (`isEmpty`) draws no operand control at all.
 */

import { Box, Button, MenuItem, Stack, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { DataTableColumn, DataTableFilter, DataTableFilterValue } from '../types';
import {
  filterTypeOf,
  operatorArity,
  operatorLabel,
  operatorsForColumn,
} from './operators';
import { blankValueFor, columnForFilter, draftFilterFor, isFilterComplete } from './filterModel';

export interface FilterEditorProps<Row> {
  /** Filterable columns only. */
  columns: DataTableColumn<Row>[];
  draft: DataTableFilter;
  onDraftChange: (next: DataTableFilter) => void;
  onCommit: (filter: DataTableFilter) => void;
  /** `'row'` on desktop/tablet, `'stacked'` in the phone sheet. */
  orientation?: 'row' | 'stacked';
}

/** Shared sizing so every control in the form is a legal touch target. */
const CONTROL_SX = { '& .MuiInputBase-root': { minHeight: 44 } } as const;

export function FilterEditor<Row>({
  columns,
  draft,
  onDraftChange,
  onCommit,
  orientation = 'row',
}: FilterEditorProps<Row>) {
  const column = columnForFilter(columns, draft) ?? columns[0];
  if (!column) return null;

  const filterType = filterTypeOf(column);
  const operators = operatorsForColumn(column);
  const arity = operatorArity(draft.operator);
  const complete = isFilterComplete(draft);
  const stacked = orientation === 'stacked';

  // Switching column invalidates both the operator and the operand: `contains`
  // is meaningless on a boolean, and `'failed'` on an `attempts` column.
  const changeColumn = (columnId: string) => {
    const next = columns.find((entry) => entry.id === columnId);
    if (next) onDraftChange(draftFilterFor(next));
  };

  // Switching operator keeps the column but resets the operand whenever the
  // arity changes — a `between` pair cannot be reinterpreted as a scalar.
  const changeOperator = (operator: string) => {
    const nextArity = operatorArity(operator as DataTableFilter['operator']);
    const keepValue = nextArity === arity;
    onDraftChange({
      ...draft,
      operator: operator as DataTableFilter['operator'],
      value: keepValue ? draft.value : blankValueFor(nextArity),
    });
  };

  const changeValue = (value: DataTableFilterValue) => onDraftChange({ ...draft, value });

  const changePairEntry = (index: 0 | 1, raw: string) => {
    const pair = Array.isArray(draft.value) ? [...draft.value] : ['', ''];
    pair[index] = filterType === 'number' && raw !== '' ? Number(raw) : raw;
    changeValue(pair as (string | number)[]);
  };

  const pairValue = (index: 0 | 1): string => {
    if (!Array.isArray(draft.value)) return '';
    const entry = draft.value[index];
    return entry === undefined || entry === null ? '' : String(entry);
  };

  const scalarValue = (): string => {
    if (draft.value === null || Array.isArray(draft.value)) return '';
    return String(draft.value);
  };

  const commit = () => {
    if (complete) onCommit(draft);
  };

  return (
    <Box
      data-testid="datatable-filter-editor"
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
      sx={{ minWidth: 0, maxWidth: '100%' }}
    >
      <Stack
        direction={stacked ? 'column' : 'row'}
        spacing={1}
        useFlexGap
        sx={{ flexWrap: stacked ? 'nowrap' : 'wrap', alignItems: stacked ? 'stretch' : 'center' }}
      >
        <TextField
          select
          size="small"
          label="Column"
          value={column.id}
          onChange={(event) => changeColumn(event.target.value)}
          sx={{ minWidth: 160, ...(stacked ? {} : { flex: '0 1 200px' }), ...CONTROL_SX }}
        >
          {columns.map((entry) => (
            <MenuItem key={entry.id} value={entry.id}>
              {entry.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Operator"
          value={draft.operator}
          onChange={(event) => changeOperator(event.target.value)}
          sx={{ minWidth: 150, ...(stacked ? {} : { flex: '0 1 180px' }), ...CONTROL_SX }}
        >
          {operators.map((operator) => (
            <MenuItem key={operator} value={operator} data-operator={operator}>
              {operatorLabel(operator, filterType)}
            </MenuItem>
          ))}
        </TextField>

        {arity === 2 ? (
          <>
            <ValueField
              label="From"
              filterType={filterType}
              column={column}
              value={pairValue(0)}
              onChange={(raw) => changePairEntry(0, raw)}
              stacked={stacked}
            />
            <ValueField
              label="To"
              filterType={filterType}
              column={column}
              value={pairValue(1)}
              onChange={(raw) => changePairEntry(1, raw)}
              stacked={stacked}
            />
          </>
        ) : arity === 'many' ? (
          <TextField
            select
            size="small"
            label="Value"
            value={Array.isArray(draft.value) ? draft.value.map(String) : []}
            onChange={(event) => {
              const raw = event.target.value;
              changeValue(
                (typeof raw === 'string' ? raw.split(',') : (raw as unknown as string[])).filter(
                  Boolean,
                ),
              );
            }}
            slotProps={{ select: { multiple: true } }}
            sx={{ minWidth: 180, ...(stacked ? {} : { flex: '1 1 220px' }), ...CONTROL_SX }}
          >
            {(column.enumValues ?? []).map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        ) : arity === 1 ? (
          <ValueField
            label="Value"
            filterType={filterType}
            column={column}
            value={scalarValue()}
            onChange={(raw) =>
              changeValue(
                filterType === 'number'
                  ? raw === ''
                    ? ''
                    : Number(raw)
                  : filterType === 'boolean'
                    ? raw === 'true'
                    : raw,
              )
            }
            stacked={stacked}
          />
        ) : null}

        <Button
          type="submit"
          variant="contained"
          size="small"
          startIcon={<AddIcon />}
          disabled={!complete}
          data-testid="datatable-filter-apply"
          sx={{ minHeight: 44, flex: '0 0 auto' }}
        >
          Add
        </Button>
      </Stack>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Operand control
// ---------------------------------------------------------------------------

interface ValueFieldProps<Row> {
  label: string;
  filterType: ReturnType<typeof filterTypeOf>;
  column: DataTableColumn<Row>;
  value: string;
  onChange: (raw: string) => void;
  stacked: boolean;
}

function ValueField<Row>({
  label,
  filterType,
  column,
  value,
  onChange,
  stacked,
}: ValueFieldProps<Row>) {
  const sx = {
    minWidth: 140,
    ...(stacked ? {} : { flex: '1 1 180px' }),
    ...CONTROL_SX,
  };

  if (filterType === 'enum' || filterType === 'boolean') {
    const options =
      filterType === 'boolean'
        ? [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]
        : (column.enumValues ?? []);
    return (
      <TextField
        select
        size="small"
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        sx={sx}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  return (
    <TextField
      size="small"
      label={label}
      type={filterType === 'number' ? 'number' : filterType === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      // A native date input renders its own placeholder text, which overlaps a
      // floating label unless the label is pinned shrunk.
      slotProps={filterType === 'date' ? { inputLabel: { shrink: true } } : undefined}
      sx={sx}
    />
  );
}
