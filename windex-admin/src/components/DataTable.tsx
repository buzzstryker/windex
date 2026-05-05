import React from 'react';

interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  headerProps?: React.ThHTMLAttributes<HTMLTableCellElement>;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** When set, the row with this key gets a selected-row highlight (e.g. for queue detail panels). */
  selectedRowKey?: string | null;
}

export function DataTable<T>({ columns, data, getRowKey, onRowClick, selectedRowKey }: DataTableProps<T>) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} {...col.headerProps}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const rowKey = getRowKey(row);
            const isSelected = selectedRowKey != null && rowKey === selectedRowKey;
            return (
            <tr
              key={rowKey}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
              className={isSelected ? 'selected-row' : undefined}
            >
              {columns.map((col) => (
                <td key={col.key}>
                  {col.render ? col.render(row) : (row as Record<string, unknown>)[col.key] as React.ReactNode}
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
