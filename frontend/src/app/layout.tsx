'use client';

/**
 * Root Layout
 *
 * Sets up:
 *  - Global dark theme
 *  - TanStack React Query provider
 *  - Sidebar navigation
 *  - Top header with instrument search bar
 *  - WebSocket connection on boot
 */

import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import '@/styles/globals.css';
import { loadTokens } from '@/services/api';
import { getWebSocketService } from '@/services/websocket';
import { useInstrumentSearch } from '@/hooks/useInstrumentSearch';

/* ------------------------------------------------------------------ */
/*  Query client — stable singleton                                   */
/* ------------------------------------------------------------------ */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

/* ------------------------------------------------------------------ */
/*  Navigation config                                                 */
/* ------------------------------------------------------------------ */

interface NavItem {
  href: string;
  label: string;
  icon: string; // simple text icons to avoid a dependency
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: '\u25A6' },        // grid icon
  { href: '/news', label: 'News', icon: '\u2139' },         // info icon
  { href: '/calendar', label: 'Calendar', icon: '\u2637' }, // calendar icon
];

/* ------------------------------------------------------------------ */
/*  Search Bar                                                        */
/* ------------------------------------------------------------------ */

function SearchBar() {
  const { results, isLoading, query, setQuery, clear } = useInstrumentSearch();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSelect(id: string) {
    clear();
    setOpen(false);
    router.push(`/instrument/${id}`);
  }

  return (
    <div ref={wrapperRef} className="relative w-full max-w-md">
      <input
        type="text"
        placeholder="Search instruments... (e.g. AAPL, S&P 500)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        className="w-full rounded-md border border-terminal-border bg-terminal-bg-tertiary px-3 py-1.5 text-sm text-terminal-text placeholder-terminal-text-dim focus:border-terminal-accent focus:outline-none"
      />

      {/* Dropdown */}
      {open && (results.length > 0 || isLoading) && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-terminal-border bg-terminal-bg-secondary shadow-xl">
          {isLoading && results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-terminal-text-muted">Searching...</div>
          ) : (
            <ul className="terminal-scroll max-h-72 py-1">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => handleSelect(r.id)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-terminal-bg-hover"
                  >
                    <span className="font-mono text-sm font-bold text-terminal-accent">
                      {r.primaryTicker}
                    </span>
                    <span className="flex-1 truncate text-xs text-terminal-text-secondary">
                      {r.name}
                    </span>
                    <span className="rounded bg-terminal-bg-elevated px-1.5 py-0.5 text-xxs font-semibold text-terminal-text-muted">
                      {r.type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                           */
/* ------------------------------------------------------------------ */

function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-52 flex-shrink-0 flex-col border-r border-terminal-border bg-terminal-bg-secondary">
      {/* Logo */}
      <div className="flex h-12 items-center border-b border-terminal-border px-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-mono text-base font-black tracking-tight text-terminal-accent">
            CHATABLES
          </span>
        </Link>
      </div>

      {/* Nav links */}
      <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                isActive ? 'sidebar-link-active' : 'sidebar-link',
              )}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Connection status */}
      <div className="border-t border-terminal-border px-4 py-3">
        <div className="flex items-center gap-2 text-xxs text-terminal-text-muted">
          <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-terminal-gain" />
          Connected
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Root Layout                                                       */
/* ------------------------------------------------------------------ */

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  // Boot: load persisted auth tokens and connect WebSocket
  useEffect(() => {
    loadTokens();
    const ws = getWebSocketService();
    ws.connect();
    return () => ws.disconnect();
  }, []);

  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Chatables Terminal</title>
        {/* Preconnect to Google Fonts for JetBrains Mono + Inter */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-terminal-bg text-terminal-text">
        <QueryClientProvider client={queryClient}>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />

            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Top header */}
              <header className="flex h-12 flex-shrink-0 items-center gap-4 border-b border-terminal-border bg-terminal-bg-secondary px-4">
                <SearchBar />

                <div className="ml-auto flex items-center gap-3 text-xs text-terminal-text-muted">
                  <span className="font-mono">
                    {new Date().toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
              </header>

              {/* Main content */}
              <main className="terminal-scroll flex-1 overflow-y-auto p-4">
                {children}
              </main>
            </div>
          </div>
        </QueryClientProvider>
      </body>
    </html>
  );
}
