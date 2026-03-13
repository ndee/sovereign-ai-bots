#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BOTS_DIR = ROOT / "bots"


def fail(errors: list[str]) -> int:
    for error in errors:
        print(f"ERROR: {error}")
    return 1


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def list_bot_directories() -> list[Path]:
    if not BOTS_DIR.is_dir():
        raise RuntimeError(f"Missing bot catalog directory: {BOTS_DIR}")
    return sorted(entry for entry in BOTS_DIR.iterdir() if entry.is_dir())


def list_json_files() -> list[Path]:
    return sorted(path for path in BOTS_DIR.rglob("*.json") if path.is_file())


def load_packages() -> tuple[list[dict[str, Any]], list[str]]:
    packages: list[dict[str, Any]] = []
    errors: list[str] = []
    for package_dir in list_bot_directories():
      manifest_path = package_dir / "sovereign-bot.json"
      if not manifest_path.is_file():
          errors.append(f"{package_dir.relative_to(ROOT)} is missing sovereign-bot.json")
          continue
      try:
          manifest = load_json(manifest_path)
      except json.JSONDecodeError as exc:
          errors.append(
              f"{manifest_path.relative_to(ROOT)} is not valid JSON: {exc.msg} at line {exc.lineno} column {exc.colno}"
          )
          continue
      packages.append(
          {
              "dir": package_dir,
              "manifest_path": manifest_path,
              "manifest": manifest,
          }
      )
    return packages, errors


def expect_object(value: Any, label: str, errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return None
    return value


def expect_list(value: Any, label: str, errors: list[str]) -> list[Any] | None:
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return None
    return value


def expect_string(value: Any, label: str, errors: list[str], *, non_empty: bool = True) -> str | None:
    if not isinstance(value, str):
        errors.append(f"{label} must be a string")
        return None
    if non_empty and value.strip() == "":
        errors.append(f"{label} must not be empty")
        return None
    return value


def expect_bool(value: Any, label: str, errors: list[str]) -> bool | None:
    if not isinstance(value, bool):
        errors.append(f"{label} must be a boolean")
        return None
    return value


def expect_number(value: Any, label: str, errors: list[str]) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        errors.append(f"{label} must be a finite number")
        return None
    return value


def expect_optional_bool(value: Any, label: str, errors: list[str]) -> None:
    if value is not None:
        expect_bool(value, label, errors)


def expect_string_list(value: Any, label: str, errors: list[str], *, allow_empty: bool) -> list[str] | None:
    items = expect_list(value, label, errors)
    if items is None:
        return None
    if not allow_empty and not items:
        errors.append(f"{label} must not be empty")
    result: list[str] = []
    for index, item in enumerate(items):
        text = expect_string(item, f"{label}[{index}]", errors)
        if text is not None:
            result.append(text)
    return result


def expect_binding_map(value: Any, label: str, errors: list[str]) -> dict[str, dict[str, Any]] | None:
    mapping = expect_object(value, label, errors)
    if mapping is None:
        return None
    normalized: dict[str, dict[str, Any]] = {}
    for key, raw_binding in mapping.items():
        binding = expect_object(raw_binding, f"{label}.{key}", errors)
        if binding is None:
            continue
        expect_string(binding.get("from"), f"{label}.{key}.from", errors)
        stringify = binding.get("stringify")
        if stringify is not None:
            expect_bool(stringify, f"{label}.{key}.stringify", errors)
        normalized[key] = binding
    return normalized


def validate_manifest_types(package: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    manifest = expect_object(package["manifest"], str(package["manifest_path"].relative_to(ROOT)), errors)
    if manifest is None:
        return errors

    expect_string(manifest.get("kind"), "kind", errors)
    if manifest.get("kind") != "sovereign-bot-package":
        errors.append("kind must be 'sovereign-bot-package'")
    expect_string(manifest.get("id"), "id", errors)
    expect_string(manifest.get("version"), "version", errors)
    expect_string(manifest.get("displayName"), "displayName", errors)
    expect_string(manifest.get("description"), "description", errors)
    if "defaultInstall" in manifest:
        expect_bool(manifest.get("defaultInstall"), "defaultInstall", errors)
    if "helloMessage" in manifest:
        expect_string(manifest.get("helloMessage"), "helloMessage", errors)

    matrix_identity = expect_object(manifest.get("matrixIdentity"), "matrixIdentity", errors)
    if matrix_identity is not None:
        mode = expect_string(matrix_identity.get("mode"), "matrixIdentity.mode", errors)
        if mode is not None and mode not in {"service-account", "dedicated-account"}:
            errors.append("matrixIdentity.mode must be 'service-account' or 'dedicated-account'")
        expect_string(matrix_identity.get("localpartPrefix"), "matrixIdentity.localpartPrefix", errors)

    matrix_routing = manifest.get("matrixRouting")
    if matrix_routing is not None:
        routing = expect_object(matrix_routing, "matrixRouting", errors)
        if routing is not None:
            expect_optional_bool(routing.get("defaultAccount"), "matrixRouting.defaultAccount", errors)
            dm = routing.get("dm")
            if dm is not None:
                dm_object = expect_object(dm, "matrixRouting.dm", errors)
                if dm_object is not None:
                    expect_optional_bool(dm_object.get("enabled"), "matrixRouting.dm.enabled", errors)
            alert_room = routing.get("alertRoom")
            if alert_room is not None:
                alert_room_object = expect_object(alert_room, "matrixRouting.alertRoom", errors)
                if alert_room_object is not None:
                    expect_optional_bool(
                        alert_room_object.get("autoReply"),
                        "matrixRouting.alertRoom.autoReply",
                        errors,
                    )
                    expect_optional_bool(
                        alert_room_object.get("requireMention"),
                        "matrixRouting.alertRoom.requireMention",
                        errors,
                    )

    config_defaults = manifest.get("configDefaults", {})
    config_defaults_object = expect_object(config_defaults, "configDefaults", errors)
    if config_defaults_object is not None:
        for key, value in config_defaults_object.items():
            if isinstance(value, bool) or isinstance(value, str):
                continue
            if isinstance(value, (int, float)) and math.isfinite(value):
                continue
            errors.append(f"configDefaults.{key} must be a string, boolean, or finite number")

    tool_templates = expect_list(manifest.get("toolTemplates", []), "toolTemplates", errors)
    if tool_templates is not None:
        for index, raw_template in enumerate(tool_templates):
            label = f"toolTemplates[{index}]"
            template = expect_object(raw_template, label, errors)
            if template is None:
                continue
            expect_string(template.get("kind"), f"{label}.kind", errors)
            if template.get("kind") != "sovereign-tool-template":
                errors.append(f"{label}.kind must be 'sovereign-tool-template'")
            expect_string(template.get("id"), f"{label}.id", errors)
            expect_string(template.get("version"), f"{label}.version", errors)
            expect_string(template.get("description"), f"{label}.description", errors)
            expect_string_list(template.get("capabilities", []), f"{label}.capabilities", errors, allow_empty=False)
            expect_string_list(
                template.get("requiredSecretRefs", []),
                f"{label}.requiredSecretRefs",
                errors,
                allow_empty=True,
            )
            expect_string_list(
                template.get("requiredConfigKeys", []),
                f"{label}.requiredConfigKeys",
                errors,
                allow_empty=True,
            )
            expect_string_list(
                template.get("allowedCommands", []),
                f"{label}.allowedCommands",
                errors,
                allow_empty=True,
            )
            expect_string_list(
                template.get("openclawPlugins", []),
                f"{label}.openclawPlugins",
                errors,
                allow_empty=True,
            )
            expect_string_list(
                template.get("openclawToolNames", []),
                f"{label}.openclawToolNames",
                errors,
                allow_empty=True,
            )

    tool_instances = expect_list(manifest.get("toolInstances", []), "toolInstances", errors)
    if tool_instances is not None:
        for index, raw_instance in enumerate(tool_instances):
            label = f"toolInstances[{index}]"
            instance = expect_object(raw_instance, label, errors)
            if instance is None:
                continue
            expect_string(instance.get("id"), f"{label}.id", errors)
            expect_string(instance.get("templateRef"), f"{label}.templateRef", errors)
            enabled_when = instance.get("enabledWhen")
            if enabled_when is not None:
                enabled_when_object = expect_object(enabled_when, f"{label}.enabledWhen", errors)
                if enabled_when_object is not None:
                    expect_string(enabled_when_object.get("path"), f"{label}.enabledWhen.path", errors)
                    equals_value = enabled_when_object.get("equals")
                    if equals_value is not None:
                        if isinstance(equals_value, bool) or isinstance(equals_value, str):
                            pass
                        elif isinstance(equals_value, (int, float)) and math.isfinite(equals_value):
                            pass
                        else:
                            errors.append(
                                f"{label}.enabledWhen.equals must be a string, boolean, or finite number"
                            )
            expect_binding_map(instance.get("config", {}), f"{label}.config", errors)
            expect_binding_map(instance.get("secretRefs", {}), f"{label}.secretRefs", errors)

    openclaw = expect_object(manifest.get("openclaw", {}), "openclaw", errors)
    if openclaw is not None:
        cron = openclaw.get("cron")
        if cron is not None:
            cron_object = expect_object(cron, "openclaw.cron", errors)
            if cron_object is not None:
                expect_string(cron_object.get("id"), "openclaw.cron.id", errors)
                if "everyConfigKey" in cron_object:
                    expect_string(cron_object.get("everyConfigKey"), "openclaw.cron.everyConfigKey", errors)
                if "defaultEvery" in cron_object:
                    expect_string(cron_object.get("defaultEvery"), "openclaw.cron.defaultEvery", errors)
                if "session" in cron_object:
                    session = expect_string(cron_object.get("session"), "openclaw.cron.session", errors)
                    if session is not None and session != "isolated":
                        errors.append("openclaw.cron.session must be 'isolated'")
                if "announce" in cron_object:
                    expect_bool(cron_object.get("announce"), "openclaw.cron.announce", errors)
                expect_string(cron_object.get("message"), "openclaw.cron.message", errors)

    agent_template = expect_object(manifest.get("agentTemplate"), "agentTemplate", errors)
    if agent_template is not None:
        expect_string(agent_template.get("id"), "agentTemplate.id", errors)
        expect_string(agent_template.get("version"), "agentTemplate.version", errors)
        expect_string(agent_template.get("description"), "agentTemplate.description", errors)
        if "model" in agent_template:
            expect_string(agent_template.get("model"), "agentTemplate.model", errors)
        matrix = expect_object(agent_template.get("matrix"), "agentTemplate.matrix", errors)
        if matrix is not None:
            expect_string(matrix.get("localpartPrefix"), "agentTemplate.matrix.localpartPrefix", errors)
        for field_name in ("requiredToolTemplates", "optionalToolTemplates"):
            tool_refs = expect_list(agent_template.get(field_name, []), f"agentTemplate.{field_name}", errors)
            if tool_refs is None:
                continue
            for index, raw_ref in enumerate(tool_refs):
                label = f"agentTemplate.{field_name}[{index}]"
                ref = expect_object(raw_ref, label, errors)
                if ref is None:
                    continue
                expect_string(ref.get("id"), f"{label}.id", errors)
                expect_string(ref.get("version"), f"{label}.version", errors)
        workspace_files = expect_list(agent_template.get("workspaceFiles"), "agentTemplate.workspaceFiles", errors)
        if workspace_files is not None:
            if not workspace_files:
                errors.append("agentTemplate.workspaceFiles must not be empty")
            for index, raw_file in enumerate(workspace_files):
                label = f"agentTemplate.workspaceFiles[{index}]"
                entry = expect_object(raw_file, label, errors)
                if entry is None:
                    continue
                expect_string(entry.get("path"), f"{label}.path", errors)
                expect_string(entry.get("source"), f"{label}.source", errors)

    return [f"{package['manifest_path'].relative_to(ROOT)}: {error}" for error in errors]


def is_safe_relative_path(value: str) -> bool:
    candidate = PurePosixPath(value)
    return not candidate.is_absolute() and ".." not in candidate.parts and value.strip() != ""


def unique(values: list[str]) -> bool:
    return len(values) == len(set(values))


def validate_package_invariants(package: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    manifest = package["manifest"]
    package_dir = package["dir"]
    manifest_path = package["manifest_path"].relative_to(ROOT)
    bot_id = manifest.get("id")

    if bot_id != package_dir.name:
        errors.append(f"{manifest_path}: manifest id '{bot_id}' must match directory '{package_dir.name}'")

    agent_template = manifest.get("agentTemplate", {})
    if agent_template.get("id") != manifest.get("id"):
        errors.append(f"{manifest_path}: agentTemplate.id must match manifest id")
    if agent_template.get("version") != manifest.get("version"):
        errors.append(f"{manifest_path}: agentTemplate.version must match manifest version")

    matrix_identity = manifest.get("matrixIdentity", {})
    agent_matrix = agent_template.get("matrix", {})
    if matrix_identity.get("localpartPrefix") != agent_matrix.get("localpartPrefix"):
        errors.append(f"{manifest_path}: agentTemplate.matrix.localpartPrefix must match matrixIdentity.localpartPrefix")

    tool_templates = manifest.get("toolTemplates", [])
    local_tool_refs = [f"{entry['id']}@{entry['version']}" for entry in tool_templates]
    if not unique(local_tool_refs):
        errors.append(f"{manifest_path}: toolTemplates must use unique id@version pairs")

    tool_instances = manifest.get("toolInstances", [])
    tool_instance_ids = [entry.get("id") for entry in tool_instances]
    if not unique([entry for entry in tool_instance_ids if isinstance(entry, str)]):
        errors.append(f"{manifest_path}: toolInstances must use unique ids")

    declared_agent_refs = []
    for field_name in ("requiredToolTemplates", "optionalToolTemplates"):
        for entry in agent_template.get(field_name, []):
            declared_agent_refs.append(f"{entry['id']}@{entry['version']}")
    if not unique(declared_agent_refs):
        errors.append(f"{manifest_path}: agentTemplate tool template refs must be unique across required and optional lists")

    allowed_refs = set(local_tool_refs) | set(declared_agent_refs)
    local_templates_by_ref = {f"{entry['id']}@{entry['version']}": entry for entry in tool_templates}
    for index, instance in enumerate(tool_instances):
        template_ref = instance.get("templateRef")
        if template_ref not in allowed_refs:
            errors.append(
                f"{manifest_path}: toolInstances[{index}].templateRef '{template_ref}' is not declared by the package"
            )
            continue
        local_template = local_templates_by_ref.get(template_ref)
        if local_template is not None:
            required_config_keys = local_template.get("requiredConfigKeys", [])
            required_secret_refs = local_template.get("requiredSecretRefs", [])
            config_keys = set(instance.get("config", {}).keys())
            secret_keys = set(instance.get("secretRefs", {}).keys())
            missing_config = sorted(key for key in required_config_keys if key not in config_keys)
            missing_secrets = sorted(key for key in required_secret_refs if key not in secret_keys)
            if missing_config:
                errors.append(
                    f"{manifest_path}: toolInstances[{index}] is missing required config bindings: {', '.join(missing_config)}"
                )
            if missing_secrets:
                errors.append(
                    f"{manifest_path}: toolInstances[{index}] is missing required secret bindings: {', '.join(missing_secrets)}"
                )

    workspace_files = agent_template.get("workspaceFiles", [])
    workspace_paths = [entry.get("path") for entry in workspace_files]
    workspace_sources = [entry.get("source") for entry in workspace_files]
    if not unique([entry for entry in workspace_paths if isinstance(entry, str)]):
        errors.append(f"{manifest_path}: agentTemplate.workspaceFiles paths must be unique")
    if not unique([entry for entry in workspace_sources if isinstance(entry, str)]):
        errors.append(f"{manifest_path}: agentTemplate.workspaceFiles sources must be unique")

    for index, entry in enumerate(workspace_files):
        target_path = entry.get("path")
        source_path = entry.get("source")
        if not isinstance(target_path, str) or not isinstance(source_path, str):
            continue
        if not is_safe_relative_path(target_path):
            errors.append(f"{manifest_path}: agentTemplate.workspaceFiles[{index}].path must be a safe relative path")
        if not is_safe_relative_path(source_path):
            errors.append(f"{manifest_path}: agentTemplate.workspaceFiles[{index}].source must be a safe relative path")
            continue
        if not source_path.startswith("workspace/"):
            errors.append(f"{manifest_path}: agentTemplate.workspaceFiles[{index}].source must stay under workspace/")
        resolved_source = package_dir / source_path
        if not resolved_source.is_file():
            errors.append(
                f"{manifest_path}: agentTemplate.workspaceFiles[{index}].source '{source_path}' does not exist"
            )

    default_account = manifest.get("matrixRouting", {}).get("defaultAccount")
    if default_account is True and matrix_identity.get("mode") != "dedicated-account":
        errors.append(f"{manifest_path}: matrixRouting.defaultAccount requires matrixIdentity.mode = dedicated-account")

    return errors


def validate_repo_invariants(packages: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    ids = [package["manifest"].get("id") for package in packages]
    normalized_ids = [entry for entry in ids if isinstance(entry, str)]
    if not unique(normalized_ids):
        errors.append("Bot package ids must be unique across the catalog")

    default_accounts = [
        package["manifest"].get("id")
        for package in packages
        if package["manifest"].get("matrixRouting", {}).get("defaultAccount") is True
    ]
    if len(default_accounts) > 1:
        errors.append(
            "Only one bot package may set matrixRouting.defaultAccount=true; found "
            + ", ".join(sorted(str(entry) for entry in default_accounts))
        )
    return errors


def run_lint() -> int:
    errors: list[str] = []
    for path in list_json_files():
        relative_path = path.relative_to(ROOT)
        try:
            raw = path.read_text(encoding="utf-8")
            parsed = json.loads(raw)
        except UnicodeDecodeError:
            errors.append(f"{relative_path} is not valid UTF-8 text")
            continue
        except json.JSONDecodeError as exc:
            errors.append(
                f"{relative_path} is not valid JSON: {exc.msg} at line {exc.lineno} column {exc.colno}"
            )
            continue

        canonical = json.dumps(parsed, indent=2, ensure_ascii=True) + "\n"
        if raw != canonical:
            errors.append(f"{relative_path} is not formatted with two-space canonical JSON")

    if errors:
        return fail(errors)

    print(f"Lint passed for {len(list_json_files())} JSON files.")
    return 0


def run_typecheck() -> int:
    packages, load_errors = load_packages()
    errors = list(load_errors)
    for package in packages:
        errors.extend(validate_manifest_types(package))
    if errors:
        return fail(errors)

    print(f"Typecheck passed for {len(packages)} bot packages.")
    return 0


def run_test() -> int:
    packages, load_errors = load_packages()
    errors = list(load_errors)
    for package in packages:
        errors.extend(validate_manifest_types(package))
        errors.extend(validate_package_invariants(package))
    errors.extend(validate_repo_invariants(packages))
    if errors:
        return fail(errors)

    print(f"Catalog tests passed for {len(packages)} bot packages.")
    return 0


def run_smoke() -> int:
    packages, load_errors = load_packages()
    errors = list(load_errors)
    for package in packages:
        errors.extend(validate_manifest_types(package))
        errors.extend(validate_package_invariants(package))
    errors.extend(validate_repo_invariants(packages))
    if errors:
        return fail(errors)

    with tempfile.TemporaryDirectory(prefix="sovereign-bot-catalog-") as temp_dir:
        temp_root = Path(temp_dir)
        for package in packages:
            manifest = package["manifest"]
            destination_root = temp_root / str(manifest["id"])
            for entry in manifest["agentTemplate"]["workspaceFiles"]:
                source = package["dir"] / entry["source"]
                destination = destination_root / entry["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
            print(
                f"Smoked {manifest['id']}@{manifest['version']} with "
                f"{len(manifest['agentTemplate']['workspaceFiles'])} workspace files."
            )

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate the Sovereign bot catalog.")
    parser.add_argument("command", choices=["lint", "typecheck", "test", "smoke"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "lint":
        return run_lint()
    if args.command == "typecheck":
        return run_typecheck()
    if args.command == "test":
        return run_test()
    if args.command == "smoke":
        return run_smoke()
    print(f"Unsupported command: {args.command}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
