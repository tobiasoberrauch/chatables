'use client';

/**
 * News Page
 *
 * Full-page news feed with filtering controls.
 */

import NewsFeed from '@/components/news/NewsFeed';

export default function NewsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-terminal-text">Market News</h1>
      </div>

      <NewsFeed maxHeight="calc(100vh - 140px)" pageSize={40} />
    </div>
  );
}
