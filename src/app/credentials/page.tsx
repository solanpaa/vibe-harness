"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function CredentialsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Credentials</h1>
          <p className="text-muted-foreground">
            Manage credential sets injected into agent sandboxes
          </p>
        </div>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Credential Set
        </Button>
      </div>

      <Card>
        <CardContent className="flex items-center justify-center h-48">
          <div className="text-center text-muted-foreground">
            <p>No credential sets yet.</p>
            <p className="text-sm">Create a set to manage API keys, tokens, and Docker logins for your agents.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
