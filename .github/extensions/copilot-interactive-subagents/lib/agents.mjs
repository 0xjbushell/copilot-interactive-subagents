function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniqueStable(values = []) {
  return [...new Set(values.filter(Boolean))];
}

async function enumerateIdentifiers(enumerateCustomAgents) {
  if (typeof enumerateCustomAgents !== "function") {
    return [];
  }

  const agents = await enumerateCustomAgents();
  return uniqueSorted((agents ?? []).map((agent) => agent?.identifier));
}

export function validateAgentIdentifierAgainstCatalog({
  requestedIdentifier,
  runtimeRecognizedIdentifiers = [],
  builtInIdentifiers = [],
} = {}) {
  const acceptedBuiltIns = uniqueStable(builtInIdentifiers);
  const customIdentifiers = uniqueSorted(runtimeRecognizedIdentifiers);

  if (customIdentifiers.includes(requestedIdentifier)) {
    return {
      ok: true,
      identifier: requestedIdentifier,
      agentKind: "custom",
      validationMethod: "runtime-enumeration",
    };
  }

  if (acceptedBuiltIns.includes(requestedIdentifier)) {
    return {
      ok: true,
      identifier: requestedIdentifier,
      agentKind: "built-in",
      validationMethod: "explicit-built-in",
    };
  }

  return {
    ok: false,
    code: "AGENT_NOT_FOUND",
    requestedIdentifier,
    availableIdentifiers: [...customIdentifiers, ...acceptedBuiltIns],
  };
}

export async function listRuntimeAgents({
  enumerateCustomAgents,
  builtInIdentifiers = [],
} = {}) {
  const acceptedBuiltIns = uniqueStable(builtInIdentifiers);

  try {
    const runtimeRecognizedIdentifiers = await enumerateIdentifiers(enumerateCustomAgents);
    return {
      runtimeRecognizedIdentifiers,
      builtInIdentifiersAcceptedExplicitly: acceptedBuiltIns,
      exactNameOnly: true,
    };
  } catch (error) {
    return {
      ok: false,
      code: "AGENT_DISCOVERY_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      runtimeRecognizedIdentifiers: [],
      builtInIdentifiersAcceptedExplicitly: acceptedBuiltIns,
      exactNameOnly: true,
    };
  }
}

export async function validateAgentIdentifier({
  requestedIdentifier,
  enumerateCustomAgents,
  builtInIdentifiers = [],
} = {}) {
  const acceptedBuiltIns = uniqueStable(builtInIdentifiers);

  try {
    const customIdentifiers = await enumerateIdentifiers(enumerateCustomAgents);
    return validateAgentIdentifierAgainstCatalog({
      requestedIdentifier,
      runtimeRecognizedIdentifiers: customIdentifiers,
      builtInIdentifiers: acceptedBuiltIns,
    });
  } catch (error) {
    if (acceptedBuiltIns.includes(requestedIdentifier)) {
      return {
        ok: true,
        identifier: requestedIdentifier,
        agentKind: "built-in",
        validationMethod: "explicit-built-in",
      };
    }

    return {
      ok: false,
      code: "AGENT_VALIDATION_UNAVAILABLE",
      requestedIdentifier,
      availableIdentifiers: acceptedBuiltIns,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
