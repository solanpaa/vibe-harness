"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, KeyRound, Trash2, ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { toast } from "sonner";

interface CredentialSet {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  createdAt: string;
}

interface CredentialEntry {
  id: string;
  credentialSetId: string;
  key: string;
  value: string;
  type: string;
  mountPath: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  env_var: "Environment Variable",
  file_mount: "File Mount",
  docker_login: "Docker Login",
};

export default function CredentialsPage() {
  const [sets, setSets] = useState<CredentialSet[]>([]);
  const [entries, setEntries] = useState<Record<string, CredentialEntry[]>>({});
  const [expandedSets, setExpandedSets] = useState<Set<string>>(new Set());
  const [loadedSets, setLoadedSets] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [addEntryOpen, setAddEntryOpen] = useState<string | null>(null);
  const [setForm, setSetForm] = useState({ name: "", description: "" });
  const [entryForm, setEntryForm] = useState({
    key: "",
    value: "",
    type: "env_var" as string,
    mountPath: "",
    username: "",
    password: "",
  });

  useEffect(() => {
    fetch("/api/credentials")
      .then((r) => r.json())
      .then(setSets)
      .catch(() => toast.error("Failed to load credential sets"));
  }, []);

  async function loadEntries(setId: string) {
    const res = await fetch(`/api/credentials/${setId}/entries`);
    if (res.ok) {
      const data = await res.json();
      setEntries((prev) => ({ ...prev, [setId]: data }));
      setLoadedSets((prev) => new Set(prev).add(setId));
    } else {
      toast.error("Failed to load entries");
    }
  }

  function toggleExpand(setId: string) {
    setExpandedSets((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) {
        next.delete(setId);
      } else {
        next.add(setId);
        if (!loadedSets.has(setId)) {
          loadEntries(setId);
        }
      }
      return next;
    });
  }

  async function handleCreateSet(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setForm),
    });
    if (res.ok) {
      const newSet = await res.json();
      setSets((prev) => [...prev, newSet]);
      setSetForm({ name: "", description: "" });
      setCreateOpen(false);
      toast.success("Credential set created");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to create credential set");
    }
  }

  async function handleDeleteSet(credSet: CredentialSet) {
    if (!window.confirm(`Delete credential set "${credSet.name}"?`)) return;
    const res = await fetch(`/api/credentials/${credSet.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setSets((prev) => prev.filter((s) => s.id !== credSet.id));
      setEntries((prev) => {
        const next = { ...prev };
        delete next[credSet.id];
        return next;
      });
      toast.success(`Deleted "${credSet.name}"`);
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete credential set");
    }
  }

  async function handleAddEntry(e: React.FormEvent, setId: string) {
    e.preventDefault();
    // Build the request body based on credential type
    let body: Record<string, string>;
    if (entryForm.type === "docker_login") {
      body = {
        key: entryForm.key,
        value: JSON.stringify({ username: entryForm.username, password: entryForm.password }),
        type: entryForm.type,
      };
    } else if (entryForm.type === "file_mount") {
      body = {
        key: entryForm.key,
        value: entryForm.value,
        type: entryForm.type,
        mountPath: entryForm.mountPath,
      };
    } else {
      body = {
        key: entryForm.key,
        value: entryForm.value,
        type: entryForm.type,
      };
    }
    const res = await fetch(`/api/credentials/${setId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await loadEntries(setId);
      setEntryForm({ key: "", value: "", type: "env_var", mountPath: "", username: "", password: "" });
      setAddEntryOpen(null);
      toast.success("Entry added");
    } else {
      const resBody = await res.json().catch(() => null);
      toast.error(resBody?.error ?? "Failed to add entry");
    }
  }

  async function handleDeleteEntry(setId: string, entry: CredentialEntry) {
    const res = await fetch(
      `/api/credentials/${setId}/entries/${entry.id}`,
      { method: "DELETE" },
    );
    if (res.ok) {
      setEntries((prev) => ({
        ...prev,
        [setId]: (prev[setId] ?? []).filter((e) => e.id !== entry.id),
      }));
      toast.success(`Deleted entry "${entry.key}"`);
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete entry");
    }
  }

  async function handleTestEntry(setId: string, entry: CredentialEntry) {
    const res = await fetch(
      `/api/credentials/${setId}/entries/${entry.id}/test`,
      { method: "POST" },
    );
    if (res.ok) {
      const result = await res.json();
      if (result.valid) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } else {
      toast.error("Test failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Credentials</h1>
          <p className="text-muted-foreground">
            Manage credential sets injected into agent sandboxes
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Credential Set
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Credential Set</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateSet} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="setName">Name</Label>
                <Input
                  id="setName"
                  value={setForm.name}
                  onChange={(e) =>
                    setSetForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="azure-dev-creds"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setDesc">Description (optional)</Label>
                <Textarea
                  id="setDesc"
                  value={setForm.description}
                  onChange={(e) =>
                    setSetForm((f) => ({ ...f, description: e.target.value }))
                  }
                  placeholder="Azure CLI tokens and Docker registry credentials"
                />
              </div>
              <Button type="submit" className="w-full">
                Create Set
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {sets.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <KeyRound className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No credential sets yet.</p>
              <p className="text-sm">
                Create a set to manage API keys, tokens, and Docker logins.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sets.map((credSet) => {
            const isExpanded = expandedSets.has(credSet.id);
            const setEntryList = entries[credSet.id] ?? [];

            return (
              <Card key={credSet.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left"
                      onClick={() => toggleExpand(credSet.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <CardTitle className="text-lg">{credSet.name}</CardTitle>
                    </button>
                    <div className="flex items-center gap-2">
                      {isExpanded && (
                        <Dialog
                          open={addEntryOpen === credSet.id}
                          onOpenChange={(open) => {
                            setAddEntryOpen(open ? credSet.id : null);
                            if (!open) {
                              setEntryForm({ key: "", value: "", type: "env_var", mountPath: "", username: "", password: "" });
                            }
                          }}
                        >
                          <DialogTrigger
                            render={
                              <Button variant="outline" size="sm">
                                <Plus className="mr-2 h-3 w-3" />
                                Add Entry
                              </Button>
                            }
                          />
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>
                                Add Credential to {credSet.name}
                              </DialogTitle>
                            </DialogHeader>
                            <form
                              onSubmit={(e) => handleAddEntry(e, credSet.id)}
                              className="space-y-4"
                            >
                              <div className="space-y-2">
                                <Label>Type</Label>
                                <Select
                                  value={entryForm.type}
                                  onValueChange={(v) =>
                                    setEntryForm((f) => ({
                                      ...f,
                                      type: v ?? "env_var",
                                      key: "",
                                      value: "",
                                      mountPath: "",
                                      username: "",
                                      password: "",
                                    }))
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue>
                                      {entryForm.type === "env_var" ? "Environment Variable" : entryForm.type === "file_mount" ? "File Mount" : "Docker Login"}
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="env_var">
                                      Environment Variable
                                    </SelectItem>
                                    <SelectItem value="file_mount">
                                      File Mount
                                    </SelectItem>
                                    <SelectItem value="docker_login">
                                      Docker Login
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              {entryForm.type === "env_var" && (
                                <>
                                  <div className="space-y-2">
                                    <Label>Variable Name</Label>
                                    <Input
                                      value={entryForm.key}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          key: e.target.value,
                                        }))
                                      }
                                      placeholder="AZURE_CLIENT_ID"
                                      required
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Value</Label>
                                    <Input
                                      type="password"
                                      value={entryForm.value}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          value: e.target.value,
                                        }))
                                      }
                                      placeholder="Secret value (will be encrypted)"
                                      required
                                    />
                                  </div>
                                </>
                              )}

                              {entryForm.type === "file_mount" && (
                                <>
                                  <div className="space-y-2">
                                    <Label>Label</Label>
                                    <Input
                                      value={entryForm.key}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          key: e.target.value,
                                        }))
                                      }
                                      placeholder="SSH Key, Kubeconfig, etc."
                                      required
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Mount Path</Label>
                                    <Input
                                      value={entryForm.mountPath}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          mountPath: e.target.value,
                                        }))
                                      }
                                      placeholder="/root/.ssh/id_rsa"
                                      required
                                    />
                                    <p className="text-xs text-muted-foreground">
                                      Path where the file will be placed inside the sandbox
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>File Content</Label>
                                    <Textarea
                                      value={entryForm.value}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          value: e.target.value,
                                        }))
                                      }
                                      placeholder="Paste file content here (will be encrypted)"
                                      rows={5}
                                      className="font-mono text-sm"
                                      required
                                    />
                                  </div>
                                </>
                              )}

                              {entryForm.type === "docker_login" && (
                                <>
                                  <div className="space-y-2">
                                    <Label>Registry</Label>
                                    <Input
                                      value={entryForm.key}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          key: e.target.value,
                                        }))
                                      }
                                      placeholder="ghcr.io"
                                      required
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Username</Label>
                                    <Input
                                      value={entryForm.username}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          username: e.target.value,
                                        }))
                                      }
                                      placeholder="username"
                                      required
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Password / Token</Label>
                                    <Input
                                      type="password"
                                      value={entryForm.password}
                                      onChange={(e) =>
                                        setEntryForm((f) => ({
                                          ...f,
                                          password: e.target.value,
                                        }))
                                      }
                                      placeholder="Access token or password"
                                      required
                                    />
                                  </div>
                                </>
                              )}

                              <Button type="submit" className="w-full">
                                Add Entry
                              </Button>
                            </form>
                          </DialogContent>
                        </Dialog>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDeleteSet(credSet)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  {credSet.description && (
                    <p className="text-sm text-muted-foreground">
                      {credSet.description}
                    </p>
                  )}
                </CardHeader>

                {isExpanded && (
                  <CardContent className="px-3 pb-2.5 pt-0">
                    {setEntryList.length > 0 ? (
                      <div className="space-y-2">
                        {setEntryList.map((entry) => (
                          <div
                            key={entry.id}
                            className="flex items-center justify-between rounded-md border px-3 py-2"
                          >
                            <div className="flex items-center gap-3">
                              <Badge variant="outline" className="text-xs">
                                {TYPE_LABELS[entry.type] ?? entry.type}
                              </Badge>
                              <span className="font-mono text-sm">
                                {entry.key}
                              </span>
                              {entry.type === "file_mount" && entry.mountPath && (
                                <span className="text-xs text-muted-foreground">
                                  → {entry.mountPath}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-muted-foreground">
                                •••••••
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() =>
                                  handleTestEntry(credSet.id, entry)
                                }
                                title="Test credential"
                              >
                                <FlaskConical className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() =>
                                  handleDeleteEntry(credSet.id, entry)
                                }
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No entries yet. Click &quot;Add Entry&quot; to add
                        credentials.
                      </p>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
