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
import { Plus, KeyRound, Trash2 } from "lucide-react";

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
  createdAt: string;
}

export default function CredentialsPage() {
  const [sets, setSets] = useState<CredentialSet[]>([]);
  const [entries, setEntries] = useState<Record<string, CredentialEntry[]>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [addEntryOpen, setAddEntryOpen] = useState<string | null>(null);
  const [setForm, setSetForm] = useState({ name: "", description: "" });
  const [entryForm, setEntryForm] = useState({
    key: "",
    value: "",
    type: "env_var" as string,
  });

  useEffect(() => {
    fetch("/api/credentials")
      .then((r) => r.json())
      .then(setSets);
  }, []);

  async function loadEntries(setId: string) {
    const res = await fetch(`/api/credentials/${setId}/entries`);
    if (res.ok) {
      const data = await res.json();
      setEntries((prev) => ({ ...prev, [setId]: data }));
    }
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
    }
  }

  async function handleAddEntry(e: React.FormEvent, setId: string) {
    e.preventDefault();
    const res = await fetch(`/api/credentials/${setId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entryForm),
    });
    if (res.ok) {
      await loadEntries(setId);
      setEntryForm({ key: "", value: "", type: "env_var" });
      setAddEntryOpen(null);
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
          {sets.map((credSet) => (
            <Card key={credSet.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{credSet.name}</CardTitle>
                  <Dialog
                    open={addEntryOpen === credSet.id}
                    onOpenChange={(open) =>
                      setAddEntryOpen(open ? credSet.id : null)
                    }
                  >
                    <DialogTrigger
                      render={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => loadEntries(credSet.id)}
                        >
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
                              setEntryForm((f) => ({ ...f, type: v ?? "env_var" }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
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
                        <div className="space-y-2">
                          <Label>Key</Label>
                          <Input
                            value={entryForm.key}
                            onChange={(e) =>
                              setEntryForm((f) => ({
                                ...f,
                                key: e.target.value,
                              }))
                            }
                            placeholder={
                              entryForm.type === "env_var"
                                ? "AZURE_CLIENT_ID"
                                : entryForm.type === "file_mount"
                                ? "/home/user/.ssh/id_rsa"
                                : "registry.example.com"
                            }
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
                        <Button type="submit" className="w-full">
                          Add Entry
                        </Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
                {credSet.description && (
                  <p className="text-sm text-muted-foreground">
                    {credSet.description}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {entries[credSet.id]?.length ? (
                  <div className="space-y-2">
                    {entries[credSet.id].map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="text-xs">
                            {entry.type}
                          </Badge>
                          <span className="font-mono text-sm">{entry.key}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          •••••••
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No entries.{" "}
                    <button
                      className="underline"
                      onClick={() => {
                        loadEntries(credSet.id);
                        setAddEntryOpen(credSet.id);
                      }}
                    >
                      Add one
                    </button>
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
