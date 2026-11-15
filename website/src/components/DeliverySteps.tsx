import { useDocsHydrated } from "@/lib/use-docs-hydrated"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion"

const steps = [
  {
    id: "shape",
    title: "Shape the work",
    summary: "An independent validator checks the contract for an authorized Issue.",
    detail: "The contract defines the scope and the evidence needed to accept the work.",
  },
  {
    id: "deliver",
    title: "Deliver and verify",
    summary:
      "A Writer implements the change. An independent Acceptor checks the Candidate.",
    detail: "The Acceptor checks the implementation against the accepted contract.",
  },
  {
    id: "merge",
    title: "Review and merge",
    summary:
      "Applicable CI and final review cover the PR head before protected integration.",
    detail: "Closure follows verification of the integration outcome.",
  },
] as const

export default function DeliverySteps() {
  const hydrated = useDocsHydrated()

  if (!hydrated) {
    return (
      <ol className="nf-delivery-steps" role="list">
        {steps.map(({ id, title, summary, detail }) => (
          <li key={id}>
            <h3 className="nf-step-title">{title}</h3>
            <p>{summary}</p>
            <p>{detail}</p>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <Accordion type="single" collapsible className="nf-delivery-steps">
      {steps.map(({ id, title, summary, detail }) => (
        <AccordionItem key={id} value={id}>
          <AccordionTrigger className="nf-step-trigger">
            <span className="grid gap-1">
              <span className="nf-step-title">{title}</span>
              <span className="nf-step-summary">{summary}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="nf-step-detail">{detail}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
