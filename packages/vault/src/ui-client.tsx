import { createRoot } from "react-dom/client";
import { VaultApp } from "./ui";

const root = document.getElementById("root");
if (!root) throw new Error("The vault application root is missing.");
createRoot(root).render(<VaultApp />);
