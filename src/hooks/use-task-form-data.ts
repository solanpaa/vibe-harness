import { useEffect, useState } from "react";
import { toast } from "sonner";

interface Project {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
  type: string;
}

interface CredentialSet {
  id: string;
  name: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  stages: Array<{
    name: string;
    promptTemplate: string;
    reviewRequired: boolean;
  }>;
}

interface TaskFormData {
  projects: Project[];
  agents: Agent[];
  credentialSets: CredentialSet[];
  workflows: WorkflowTemplate[];
  loading: boolean;
}

export function useTaskFormData(enabled: boolean): TaskFormData {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [credentialSets, setCredentialSets] = useState<CredentialSet[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    setLoading(true);
    Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/agents").then((r) => r.json()),
      fetch("/api/credentials").then((r) => r.json()),
      fetch("/api/workflows").then((r) => r.json()),
    ])
      .then(([p, a, c, w]) => {
        setProjects(p);
        setAgents(a);
        setCredentialSets(c);
        setWorkflows(w);
      })
      .catch(() => {
        toast.error("Failed to load form data");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [enabled]);

  return { projects, agents, credentialSets, workflows, loading };
}
