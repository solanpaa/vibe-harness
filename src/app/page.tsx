"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FolderGit2,
  Terminal,
  GitPullRequestArrow,
  Workflow,
  Loader2,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
} from "lucide-react";

interface RecentSession {
  id: string;
  projectName: string;
  status: string;
  prompt: string;
  createdAt: string;
}

interface PendingReview {
  id: string;
  round: number;
  status: string;
  createdAt: string;
  sessionId: string;
}

interface Stats {
  projectCount: number;
  activeSessionCount: number;
  pendingReviewCount: number;
  activeWorkflowCount: number;
  recentSessions: RecentSession[];
  pendingReviews: PendingReview[];
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
    case "active":
      return "default";
    case "completed":
    case "approved":
      return "secondary";
    case "failed":
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
    case "active":
      return <Loader2 className="h-3 w-3 animate-spin" />;
    case "completed":
    case "approved":
      return <CheckCircle className="h-3 w-3" />;
    case "failed":
    case "rejected":
      return <XCircle className="h-3 w-3" />;
    default:
      return <Clock className="h-3 w-3" />;
  }
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Stats = await res.json();
        if (active) {
          setStats(data);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to fetch stats");
      }
    }

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const statCards = [
    {
      title: "Projects",
      value: stats?.projectCount ?? "—",
      subtitle: "Git repositories",
      icon: FolderGit2,
      href: "/projects",
    },
    {
      title: "Active Sessions",
      value: stats?.activeSessionCount ?? "—",
      subtitle: "Running in sandbox",
      icon: Terminal,
      href: "/sessions",
    },
    {
      title: "Pending Reviews",
      value: stats?.pendingReviewCount ?? "—",
      subtitle: "Awaiting your review",
      icon: GitPullRequestArrow,
      href: "/reviews",
    },
    {
      title: "Workflows",
      value: stats?.activeWorkflowCount ?? "—",
      subtitle: "Active runs",
      icon: Workflow,
      href: "/workflows",
    },
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Orchestrate AI coding agents across your projects
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load stats: {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => (
          <Link key={card.href} href={card.href} className="group">
            <Card className="transition-colors group-hover:border-primary/50">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                <card.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats === null ? (
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  ) : (
                    card.value
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{card.subtitle}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Recent Sessions */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Sessions</CardTitle>
            <Link
              href="/sessions"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {stats === null ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : stats.recentSessions.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                No sessions yet. Create a project and launch a session to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {stats.recentSessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.id}`}
                    className="group flex items-start justify-between gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {session.projectName}
                        </span>
                        <Badge variant={statusVariant(session.status)} className="gap-1 shrink-0">
                          <StatusIcon status={session.status} />
                          {session.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {session.prompt}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {relativeTime(session.createdAt)}
                      <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pending Reviews */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Pending Reviews</CardTitle>
            <Link
              href="/reviews"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {stats === null ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : stats.pendingReviews.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                No reviews pending. Reviews appear here when agent sessions complete.
              </div>
            ) : (
              <div className="space-y-3">
                {stats.pendingReviews.map((review) => (
                  <Link
                    key={review.id}
                    href={`/reviews/${review.id}`}
                    className="group flex items-center justify-between gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Round {review.round}</span>
                      <Badge variant={statusVariant(review.status)} className="gap-1">
                        <StatusIcon status={review.status} />
                        {review.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {relativeTime(review.createdAt)}
                      <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
