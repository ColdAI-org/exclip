import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { applyBrandColors } from "./lib/brand";
import "./styles/exclip.css";

// The brand colours go on the root element before the first render, so nothing paints in the wrong accent.
applyBrandColors(document.documentElement);

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
