import { promises as fs } from "node:fs";
import {
	powershellLiteral,
	runWindowsPowerShell,
} from "./windows-powershell.js";

const securedDirectories = new Map<string, Promise<void>>();
const MAX_SECURED_DIRECTORIES = 128;

async function secureWindowsDirectory(directory: string): Promise<void> {
	await runWindowsPowerShell(
		"secure private collector storage",
		`
$root = ${powershellLiteral(directory)}
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$principals = @($owner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$count = 0
while ($pending.Count -gt 0) {
  $entry = $pending.Pop()
  try {
  $item = Get-Item -LiteralPath $entry -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private storage cannot contain filesystem links.' }
  if (++$count -gt 65536) { throw 'Private storage has too many entries to secure.' }
  if ($item.PSIsContainer) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($owner)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in $principals) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inheritance, 'None', 'Allow'))
  }
  # Set-Acl may request audit privileges on a protected DACL. Persist only
  # the changed owner and access rules so repair needs no elevation.
  $item.SetAccessControl($acl)
  $actual = Get-Acl -LiteralPath $item.FullName
  if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Private storage ACL verification failed.' }
  foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow' -or $principals.Value -notcontains $rule.IdentityReference.Value) { throw 'Private storage contains an unexpected access rule.' }
  }
  if ($item.PSIsContainer) {
    foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($item.FullName)) {
      if ($count + $pending.Count -ge 65536) { throw 'Private storage has too many entries to secure.' }
      $pending.Push($child)
    }
  }
  } catch [System.Management.Automation.ItemNotFoundException] {
    if ($entry -eq $root) { throw }
  }
}
`,
	);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		await fs.chmod(directory, 0o700);
		return;
	}
	const resolved = await fs.realpath(directory);
	let secured = securedDirectories.get(resolved);
	if (secured === undefined) {
		// ACL repair walks existing files once; collector ticks only create files
		// under these protected directories and inherit their private ACLs.
		if (securedDirectories.size >= MAX_SECURED_DIRECTORIES) {
			const oldest = securedDirectories.keys().next().value;
			if (oldest !== undefined) securedDirectories.delete(oldest);
		}
		secured = secureWindowsDirectory(resolved).catch((error: unknown) => {
			securedDirectories.delete(resolved);
			throw error;
		});
		securedDirectories.set(resolved, secured);
	}
	await secured;
}
