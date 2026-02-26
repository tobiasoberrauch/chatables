'use client';

/**
 * Calendar Page
 *
 * Displays the macroeconomic events calendar.
 */

import MacroCalendar from '@/components/calendar/MacroCalendar';

export default function CalendarPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-terminal-text">Economic Calendar</h1>
      </div>

      <MacroCalendar />
    </div>
  );
}
