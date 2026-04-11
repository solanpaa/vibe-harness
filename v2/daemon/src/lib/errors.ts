// ---------------------------------------------------------------------------
// Application error hierarchy (CDD §12)
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details ?? {},
      },
    };
  }
}

// ── ACP errors ──────────────────────────────────────────────────────

export class AcpConnectionError extends AppError {
  readonly code = 'ACP_CONNECTION_ERROR';
  readonly httpStatus = 502;
  constructor(reason: string) {
    super(`ACP connection failed: ${reason}`, { reason });
  }
}

export class AcpSessionNotActiveError extends AppError {
  readonly code = 'ACP_SESSION_NOT_ACTIVE';
  readonly httpStatus = 409;
  constructor(sandboxName: string) {
    super(`No active ACP session for sandbox '${sandboxName}'`, { sandboxName });
  }
}

export class AcpConnectionNotFoundError extends AppError {
  readonly code = 'ACP_CONNECTION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(sandboxName: string) {
    super(`No ACP connection found for sandbox '${sandboxName}'`, { sandboxName });
  }
}

// ── Git / Worktree errors ───────────────────────────────────────────

export class InvalidGitRefError extends AppError {
  readonly code = 'INVALID_GIT_REF';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Invalid git ref: ${reason}`);
  }
}

export class PathTraversalError extends AppError {
  readonly code = 'PATH_TRAVERSAL';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Path traversal detected: ${reason}`);
  }
}

export class GitOperationError extends AppError {
  readonly code = 'GIT_OPERATION_ERROR';
  readonly httpStatus = 500;
  constructor(operation: string, stderr: string) {
    super(`Git ${operation} failed: ${stderr}`, { operation, stderr });
  }
}

export class WorktreeCreateError extends AppError {
  readonly code = 'WORKTREE_CREATE_ERROR';
  readonly httpStatus = 500;
  constructor(branch: string, stderr: string) {
    super(`Failed to create worktree for branch '${branch}': ${stderr}`, { branch, stderr });
  }
}

export class WorktreeNotFoundError extends AppError {
  readonly code = 'WORKTREE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(worktreePath: string) {
    super(`Worktree not found at '${worktreePath}'`, { worktreePath });
  }
}

export class BranchAlreadyExistsError extends AppError {
  readonly code = 'BRANCH_ALREADY_EXISTS';
  readonly httpStatus = 409;
  constructor(branch: string) {
    super(`Branch '${branch}' already exists`, { branch });
  }
}

export class BranchNameError extends AppError {
  readonly code = 'BRANCH_NAME_ERROR';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Invalid branch name: ${reason}`);
  }
}

export class MergeError extends AppError {
  readonly code = 'MERGE_ERROR';
  readonly httpStatus = 409;
  constructor(branch: string, targetBranch: string, stderr: string) {
    super(
      `Cannot fast-forward merge '${branch}' into '${targetBranch}': ${stderr}`,
      { branch, targetBranch, stderr },
    );
  }
}

export class MergeConflictError extends AppError {
  readonly code = 'MERGE_CONFLICT';
  readonly httpStatus = 409;
  constructor(conflictFiles: string[]) {
    super(`Merge conflict in ${conflictFiles.length} file(s)`, { conflictFiles });
  }
}

export class GitConflictError extends AppError {
  readonly code = 'GIT_CONFLICT';
  readonly httpStatus = 409;
  constructor(operation: string, conflictFiles: string[]) {
    super(`Git ${operation} conflict in ${conflictFiles.length} file(s)`, {
      operation,
      conflictFiles,
    });
  }
}

export class RebaseConflictError extends AppError {
  readonly code = 'REBASE_CONFLICT';
  readonly httpStatus = 409;
  constructor(conflictFiles: string[]) {
    super(`Rebase conflict in ${conflictFiles.length} file(s)`, { conflictFiles });
  }
}

// ── Sandbox errors ──────────────────────────────────────────────────

export class SandboxProvisionError extends AppError {
  readonly code = 'SANDBOX_PROVISION_ERROR';
  readonly httpStatus = 500;
  constructor(sandboxName: string, reason: string) {
    super(`Failed to provision sandbox '${sandboxName}': ${reason}`, {
      sandboxName,
      reason,
    });
  }
}

export class SandboxAlreadyExistsError extends AppError {
  readonly code = 'SANDBOX_ALREADY_EXISTS';
  readonly httpStatus = 409;
  constructor(sandboxName: string) {
    super(`Sandbox '${sandboxName}' already exists`, { sandboxName });
  }
}

export class SandboxNotFoundError extends AppError {
  readonly code = 'SANDBOX_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(sandboxName: string) {
    super(`Sandbox '${sandboxName}' not found in active sandboxes`, {
      sandboxName,
    });
  }
}

export class SandboxExecError extends AppError {
  readonly code = 'SANDBOX_EXEC_ERROR';
  readonly httpStatus = 500;
  constructor(sandboxName: string, command: string, exitCode: number, stderr: string) {
    super(
      `Command failed in sandbox '${sandboxName}': ${command} (exit ${exitCode})`,
      { sandboxName, command, exitCode, stderr },
    );
  }
}
