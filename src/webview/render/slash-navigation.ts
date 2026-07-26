export function scrollSelectedSlashItemIntoView(container: ParentNode): void {
  const selectedItem = container.querySelector(".slash-item.selected");
  selectedItem?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
