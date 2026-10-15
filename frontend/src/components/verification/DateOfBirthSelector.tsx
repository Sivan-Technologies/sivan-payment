import React, { useState, useEffect, useId } from 'react';

export interface DateOfBirthSelectorProps {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (isoDate: string) => void;
  required?: boolean;
  disabled?: boolean;
  label?: string;
  caption?: string;
  showLabel?: boolean;
  showCaption?: boolean;
  showBadge?: boolean;
  className?: string;
}

const MONTHS = [
  { value: '01', short: 'Jan', label: 'Jan · January' },
  { value: '02', short: 'Feb', label: 'Feb · February' },
  { value: '03', short: 'Mar', label: 'Mar · March' },
  { value: '04', short: 'Apr', label: 'Apr · April' },
  { value: '05', short: 'May', label: 'May · May' },
  { value: '06', short: 'Jun', label: 'Jun · June' },
  { value: '07', short: 'Jul', label: 'Jul · July' },
  { value: '08', short: 'Aug', label: 'Aug · August' },
  { value: '09', short: 'Sep', label: 'Sep · September' },
  { value: '10', short: 'Oct', label: 'Oct · October' },
  { value: '11', short: 'Nov', label: 'Nov · November' },
  { value: '12', short: 'Dec', label: 'Dec · December' }
];

function parseDate(input?: string): { day: string; month: string; year: string } {
  if (!input) return { day: '', month: '', year: '' };
  const trimmed = String(input).trim();
  const iso = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (iso) return { year: iso[1], month: iso[2], day: iso[3] };
  const local = trimmed.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (local) return { day: local[1], month: local[2], year: local[3] };
  return { day: '', month: '', year: '' };
}

function getDaysInMonth(month: string, year: string): number {
  if (!month) return 31;
  const m = parseInt(month, 10);
  if ([4, 6, 9, 11].includes(m)) return 30;
  if (m === 2) {
    if (!year) return 29;
    const y = parseInt(year, 10);
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return isLeap ? 29 : 28;
  }
  return 31;
}

export function DateOfBirthSelector({
  name = 'dateOfBirth',
  value,
  defaultValue,
  onChange,
  required = true,
  disabled = false,
  label = 'Date of birth',
  caption = 'Verified against your Central Bank of Nigeria NIBSS record',
  showLabel = true,
  showCaption = true,
  showBadge = true,
  className = ''
}: DateOfBirthSelectorProps) {
  const baseId = useId();
  const initial = parseDate(value || defaultValue);

  const [day, setDay] = useState(initial.day);
  const [month, setMonth] = useState(initial.month);
  const [year, setYear] = useState(initial.year);

  // Sync state if controlled value prop changes
  useEffect(() => {
    if (value !== undefined) {
      const parsed = parseDate(value);
      setDay(parsed.day);
      setMonth(parsed.month);
      setYear(parsed.year);
    }
  }, [value]);

  // Year range: Automatic adult compliance (18+ only). 2008 down to 1940
  const currentYear = new Date().getFullYear();
  const maxYear = Math.min(2008, currentYear - 18);
  const minYear = 1940;
  const years: number[] = [];
  for (let y = maxYear; y >= minYear; y--) {
    years.push(y);
  }

  const daysCount = getDaysInMonth(month, year);
  const days: string[] = [];
  for (let d = 1; d <= daysCount; d++) {
    days.push(String(d).padStart(2, '0'));
  }

  // Handle day adjustment if month changes to one with fewer days
  useEffect(() => {
    if (day && parseInt(day, 10) > daysCount) {
      const adjustedDay = String(daysCount).padStart(2, '0');
      setDay(adjustedDay);
      if (month && year) {
        onChange?.(`${year}-${month}-${adjustedDay}`);
      }
    }
  }, [daysCount, day, month, year, onChange]);

  const handleDayChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextDay = e.target.value;
    setDay(nextDay);
    if (nextDay && month && year) {
      onChange?.(`${year}-${month}-${nextDay}`);
    } else {
      onChange?.('');
    }
  };

  const handleMonthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMonth = e.target.value;
    setMonth(nextMonth);
    const maxDays = getDaysInMonth(nextMonth, year);
    let effectiveDay = day;
    if (effectiveDay && parseInt(effectiveDay, 10) > maxDays) {
      effectiveDay = String(maxDays).padStart(2, '0');
      setDay(effectiveDay);
    }
    if (effectiveDay && nextMonth && year) {
      onChange?.(`${year}-${nextMonth}-${effectiveDay}`);
    } else {
      onChange?.('');
    }
  };

  const handleYearChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextYear = e.target.value;
    setYear(nextYear);
    const maxDays = getDaysInMonth(month, nextYear);
    let effectiveDay = day;
    if (effectiveDay && parseInt(effectiveDay, 10) > maxDays) {
      effectiveDay = String(maxDays).padStart(2, '0');
      setDay(effectiveDay);
    }
    if (effectiveDay && month && nextYear) {
      onChange?.(`${nextYear}-${month}-${effectiveDay}`);
    } else {
      onChange?.('');
    }
  };

  const combinedIso = day && month && year ? `${year}-${month}-${day}` : '';

  return (
    <div className={`dob-selector-container ${className}`.trim()}>
      {showLabel && (
        <div className="dob-header-row">
          <label htmlFor={`${baseId}-day`} className="dob-header-label">
            {label}
          </label>
          {showBadge && <span className="dob-badge-18">18+ required</span>}
        </div>
      )}

      <div className="dob-dropdowns-row">
        {/* Day Selector */}
        <div className="dob-select-wrap">
          <label htmlFor={`${baseId}-day`} className="dob-sublabel">
            Day
          </label>
          <select
            id={`${baseId}-day`}
            value={day}
            onChange={handleDayChange}
            required={required}
            disabled={disabled}
            className="dob-native-select"
            aria-label="Birth day"
          >
            <option value="">Day ▾</option>
            {days.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        {/* Month Selector */}
        <div className="dob-select-wrap">
          <label htmlFor={`${baseId}-month`} className="dob-sublabel">
            Month
          </label>
          <select
            id={`${baseId}-month`}
            value={month}
            onChange={handleMonthChange}
            required={required}
            disabled={disabled}
            className="dob-native-select"
            aria-label="Birth month"
          >
            <option value="">Month ▾</option>
            {MONTHS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Year Selector */}
        <div className="dob-select-wrap">
          <label htmlFor={`${baseId}-year`} className="dob-sublabel">
            Year
          </label>
          <select
            id={`${baseId}-year`}
            value={year}
            onChange={handleYearChange}
            required={required}
            disabled={disabled}
            className="dob-native-select"
            aria-label="Birth year"
          >
            <option value="">Year ▾</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Hidden input for standard HTML form serialize */}
      <input type="hidden" name={name} value={combinedIso} />

      {showCaption && caption && <span className="dob-caption">{caption}</span>}
    </div>
  );
}
