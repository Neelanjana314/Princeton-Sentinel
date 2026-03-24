export function describeAvailabilityReason(reason?: string | null) {
  switch ((reason || "").trim()) {
    case "blocked_site":
      return "Access to this site has been blocked";
    case "graph_not_found":
      return "Graph could not find this resource";
    case "graph_forbidden":
      return "Graph denied access to this resource";
    case "graph_gone":
      return "Graph reported this resource as gone";
    case "deleted":
      return "This resource was deleted from inventory";
    case "itemnotfound":
    case "item_not_found":
      return "Graph reported the site item was not found";
    case "resourcenotfound":
    case "resource_not_found":
      return "Graph reported the resource was not found";
    default:
      return reason ? reason.replace(/_/g, " ") : "Availability could not be verified";
  }
}
