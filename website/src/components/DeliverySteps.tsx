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
    summary:
      "Nibfin turns the authorized Issue into a plan and checks it independently.",
    detail: "The contract defines the scope and the evidence needed to accept the work.",
  },
  {
    id: "deliver",
    title: "Deliver and verify",
    summary:
      "A coding agent implements the change. A separate agent verifies it.",
    detail: "The Acceptor checks the proposed change and its evidence against the plan.",
  },
  {
    id: "merge",
    title: "Review and merge",
    summary:
      "Nibfin opens a pull request and verifies CI and review before protected merge.",
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
