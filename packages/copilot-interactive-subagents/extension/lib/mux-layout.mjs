const SUPPORTED_LAYOUT_BACKENDS = new Set(["cmux", "tmux", "zellij"]);

function determineLayoutStrategy(count) {
  if (count <= 1) {
    return "single";
  }

  if (count === 2) {
    return "split";
  }

  return "tiled";
}

function determineOrientation(backend, strategy, slot) {
  if (strategy === "single") {
    return "current";
  }

  if (strategy === "split") {
    return backend === "zellij" ? "horizontal" : "vertical";
  }

  return slot % 2 === 0 ? "horizontal" : "vertical";
}

function buildPaneLayoutEntry({ backend, launch, strategy, slot, total }) {
  const agentIdentifier = launch?.agentIdentifier ?? "subagent";

  return {
    backend,
    strategy,
    slot,
    total,
    visible: true,
    title: `${slot + 1}/${total} ${agentIdentifier}`,
    orientation: determineOrientation(backend, strategy, slot),
  };
}

export function buildMuxLayout({ backend, launches = [] } = {}) {
  if (!SUPPORTED_LAYOUT_BACKENDS.has(backend)) {
    throw new Error(`Unsupported mux backend for pane layout: ${backend}`);
  }

  const strategy = determineLayoutStrategy(launches.length);

  return {
    backend,
    strategy,
    visible: true,
    panes: launches.map((launch, slot) =>
      buildPaneLayoutEntry({
        backend,
        launch,
        strategy,
        slot,
        total: launches.length,
      })),
  };
}

