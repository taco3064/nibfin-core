import type { ReactNode } from "react"
import { useDocsHydrated } from "@/lib/use-docs-hydrated"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"

export default function CommandTabs({ preview, apply }: {
  preview: ReactNode
  apply: ReactNode
}) {
  const hydrated = useDocsHydrated()

  if (!hydrated) {
    return (
      <div className="nf-command-tabs">
        <h3>Preview</h3>
        {preview}
        <h3>Open an installation PR</h3>
        {apply}
      </div>
    )
  }

  return (
    <Tabs defaultValue="preview" className="nf-command-tabs">
      <TabsList aria-label="Repository setup commands">
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="apply">Open a PR</TabsTrigger>
      </TabsList>
      <TabsContent value="preview">{preview}</TabsContent>
      <TabsContent value="apply">{apply}</TabsContent>
    </Tabs>
  )
}
