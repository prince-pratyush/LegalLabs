// Held-out clause text for the playbook-review suite, written fresh for each starter rule.
// None of it copies a starter's sample_language; generate.test.ts checks that.
// Our client is Ardent (the Customer under the MSA); the counterparty is Corvane.

export type Status = "acceptable" | "needs_review" | "not_acceptable" | "not_found";
export type Variant = "standard" | "fallback" | "unacceptable" | "omitted";
export type Template = "nda" | "msa";

/** What a correct review says for each variant (playbooks-word.md §4.3 statuses). */
export const GOLD: Record<Variant, Status> = {
  standard: "acceptable",
  fallback: "acceptable",
  unacceptable: "not_acceptable",
  omitted: "not_found",
};

export type ClauseSpec = {
  /** The starter rule's title, exactly. */
  rule: string;
  heading: string;
  standard: string;
  fallback: string;
  unacceptable: string;
};

/** Material terms no starter rule covers; a review must list each in `gaps`. */
export type Unusual = { key: string; heading: string; text: string };

/** Boilerplate a counterparty edits with a tracked change that shifts substance. */
export type Boilerplate = { key: string; heading: string; text: string; edited: string };

export const PARTIES = {
  us: "Ardent Pty Ltd",
  them: "Corvane Systems Ltd",
};

const NDA: ClauseSpec[] = [
  {
    rule: "Mutuality",
    heading: "Roles of the parties",
    standard:
      "Both parties will share information under this agreement. Whichever party receives information is the Recipient and whichever discloses it is the Discloser, and every obligation, exception and remedy in this agreement applies to Ardent and Corvane in the same way.",
    fallback:
      "The obligations in this agreement bind both parties equally as Recipient and Discloser, except that Corvane must also apply the additional security controls in Schedule 2 to any personal data it receives from Ardent, because only Ardent will be sharing personal data.",
    unacceptable:
      "Although this agreement is described as mutual, only Corvane's information is protected by it: Ardent alone takes on the obligations of a Recipient, and the exceptions and remedies in this agreement may be relied on only by Corvane.",
  },
  {
    rule: "Definition of Confidential Information",
    heading: "Meaning of Confidential Information",
    standard:
      '"Confidential Information" means all information that is not public and that a party, or someone acting for it, discloses in connection with the Purpose, in whatever form and whether or not it is marked confidential, including anything a reasonable person would treat as confidential, as well as the existence of the parties\' talks and what was said in them.',
    fallback:
      '"Confidential Information" means information disclosed in connection with the Purpose that is marked confidential when given in writing. Information disclosed orally or visually is included if it is identified as confidential when disclosed or described as confidential in a written note sent within 30 days.',
    unacceptable:
      '"Confidential Information" means only written information that the Discloser has stamped "Trade Secret". Information disclosed orally or by demonstration is never Confidential Information.',
  },
  {
    rule: "Exclusions from Confidential Information",
    heading: "Information outside these obligations",
    standard:
      "None of the duties in this agreement covers information that the Recipient proves, using its written records, (a) has entered the public domain without any fault on the Recipient's part, (b) was already lawfully in the Recipient's hands with no restriction before it was disclosed, (c) came to the Recipient lawfully from someone else who was under no obligation of confidence, or (d) was created by the Recipient independently, without using or referring to anything the Discloser provided. These four cases are the only exclusions.",
    fallback:
      "Information is not Confidential Information if it is or becomes public through no fault of the Recipient, was lawfully known to the Recipient beforehand without restriction, is lawfully received from a third party free of any duty of confidence, is created by the Recipient on its own without relying on or consulting the Discloser's material, or has been approved for release by the Discloser in writing.",
    unacceptable:
      "Information is excluded from these obligations if it is available to the public in any form or could be pieced together from public sources, if the Recipient comes to possess it by any means, or if the Recipient reasonably considers that it is not confidential.",
  },
  {
    rule: "Permitted Use and Need-to-Know Disclosure",
    heading: "Use and onward disclosure",
    standard:
      "The Recipient may use Confidential Information solely to evaluate the proposed collaboration (the Purpose). It may share it only with those of its staff, officers and professional advisers who must see it for the Purpose and who owe duties of confidence at least as strict as this agreement, and the Recipient answers for any breach by any of them.",
    fallback:
      "Confidential Information may be used solely for the Purpose. Besides its own staff and advisers, the Recipient may share it with affiliates, contractors and financiers who require it for the Purpose, as long as each has agreed in writing to terms no less protective than these and the Recipient stays liable for whatever they do with it.",
    unacceptable:
      "The Recipient may use Confidential Information for any business purpose, including improving its own products and training its machine learning models, and may pass it to its affiliates and partners, for whom it has no responsibility.",
  },
  {
    rule: "Compelled Disclosure",
    heading: "Disclosure required by law",
    standard:
      "If a law, regulation, court order or stock exchange rule requires the Recipient to disclose Confidential Information, the Recipient must, if lawful, tell the Discloser promptly, help the Discloser seek a protective order or other remedy, and disclose no more than is legally required.",
    fallback:
      "The Recipient may disclose Confidential Information where compelled by law, but must give the Discloser notice where legally permitted and reasonably practicable and must use reasonable efforts to limit the extent of the disclosure.",
    unacceptable:
      "The Recipient may disclose Confidential Information to any government body that asks for it, formally or informally, or whenever the Recipient believes disclosure is advisable, and need not tell the Discloser.",
  },
  {
    rule: "Standard of Care",
    heading: "Protection of information",
    standard:
      "The Recipient must protect Confidential Information with at least the care it applies to its own information of a similar kind, and in any event no less than reasonable care, using appropriate technical and organisational security measures, and must tell the Discloser promptly if it becomes aware of any unauthorised access to or disclosure of it.",
    fallback:
      "The Recipient must take reasonable care to keep Confidential Information secure and must notify the Discloser within a reasonable time of any unauthorised disclosure it becomes aware of.",
    unacceptable:
      "The Recipient will use commercially reasonable efforts to try to keep Confidential Information secure, is liable only for disclosures caused by its gross negligence or wilful misconduct, and has no duty to report any disclosure.",
  },
  {
    rule: "Term and Survival",
    heading: "Duration",
    standard:
      "This agreement covers information disclosed during the three years after it is signed. The duties of the Recipient last for five years after this agreement expires or ends, and for trade secrets and personal data they last while the information stays confidential or the Recipient holds it.",
    fallback:
      "The disclosure period is two years from signing. The Recipient's obligations continue for three years after the disclosure period ends, except that obligations for trade secrets and personal data continue without time limit.",
    unacceptable:
      "The Recipient's obligations under this agreement end on the date this agreement expires or is terminated, including for any trade secrets.",
  },
  {
    rule: "Return and Destruction",
    heading: "Returning materials",
    standard:
      "Whenever the Discloser asks, or when the Purpose ends, the Recipient must promptly return or destroy all Confidential Information and every copy of it and confirm to the Discloser in writing that it has done so.",
    fallback:
      "On request or when the Purpose ends, the Recipient must return or destroy all Confidential Information, except copies held in routine electronic backups or kept to satisfy a legal requirement, which remain subject to this agreement and must not be accessed for any other purpose until they are deleted in the ordinary course.",
    unacceptable:
      "The Recipient may keep copies of any Confidential Information indefinitely for its records, and those copies are not subject to the obligations in this agreement. The Recipient has no obligation to return any material.",
  },
  {
    rule: "No Licence or Transfer of IP",
    heading: "Ownership",
    standard:
      "The Discloser keeps ownership of all of its Confidential Information. Apart from the limited right to use the information for the Purpose, nothing here gives the Recipient any licence or other right under a patent, copyright, trade secret or other intellectual property right.",
    fallback:
      "All Confidential Information stays the Discloser's property and no intellectual property licence is granted beyond use for the Purpose. Each party acknowledges that the other may independently develop similar products, provided it does not use the other's Confidential Information to do so.",
    unacceptable:
      "Ardent assigns to Corvane all rights in any feedback, ideas or suggestions it provides in the course of the discussions, and Corvane will own any improvement developed from Ardent's Confidential Information.",
  },
  {
    rule: "Residuals",
    heading: "Retained knowledge",
    standard:
      "No right is given to use Confidential Information that a person remembers. The Recipient may not use information retained in the memory of its personnel for anything other than the Purpose.",
    fallback:
      "Either party may use general skills, ideas and know-how retained in the unaided memory of its personnel who had authorised access, provided there is no deliberate memorising, no licence under any patent or copyright is granted, and this right does not extend to personal data, financial information, product or business plans, source code, security information or trade secrets.",
    unacceptable:
      "Each party may use for any purpose, including developing competing products, any information retained in the memory of its personnel, whether aided or unaided, including specific details of the other party's information.",
  },
  {
    rule: "Remedies and Injunctive Relief",
    heading: "Remedies",
    standard:
      "Each party accepts that money may not be enough to make good a breach of this agreement, so the Discloser may obtain an injunction or other equitable relief without proving actual loss and without giving security or posting a bond, on top of any other remedy.",
    fallback:
      "Each party acknowledges that equitable relief, including an injunction, is available for a breach or threatened breach of this agreement.",
    unacceptable:
      "Damages are the only remedy for breach of this agreement and neither party may seek an injunction. Ardent's total liability for any breach of confidentiality is limited to $10,000.",
  },
  {
    rule: "Non-Solicitation",
    heading: "Staff",
    standard:
      "Either party remains free to solicit, hire or engage any employee or contractor of the other party; this agreement places no limit on that.",
    fallback:
      "For twelve months after signing, neither party will actively solicit for employment any employee of the other with whom it had material contact through the discussions, but general advertisements and approaches made by an employee on their own initiative are not restricted.",
    unacceptable:
      "For three years after signing, Ardent must not hire, engage or solicit any employee of Corvane or of any Corvane affiliate, and must pay Corvane a fee equal to one year's salary for any person hired in breach.",
  },
  {
    rule: "Personal Information",
    heading: "Personal data",
    standard:
      "Where either party shares personal information, the Recipient may use it solely for the Purpose, must handle it as applicable data protection law requires and with appropriate security, and must tell the Discloser without undue delay of any breach affecting it. Before sharing any personal information beyond business contact details, the parties will sign a data processing agreement.",
    fallback:
      "Each party must comply with applicable data protection law in relation to any personal information it receives under this agreement and must notify the other of any breach affecting that information. Only business contact details are expected to be exchanged.",
    unacceptable:
      "Personal information that Ardent discloses about its staff or customers is not Confidential Information, and Corvane may store and transfer it in any country without further safeguards.",
  },
  {
    rule: "No Warranty and No Obligation to Proceed",
    heading: "No commitment",
    standard:
      "All Confidential Information is supplied as is, with no warranty of any kind. Neither party has to sign any further agreement or complete any transaction, and no commitment arises unless it is recorded in a separate written agreement that both parties sign.",
    fallback:
      "Confidential Information is provided without warranty, except that each party confirms it is entitled to disclose the information it discloses. Neither party is bound to proceed with any transaction unless a separate signed agreement says so.",
    unacceptable:
      "Ardent warrants that all information it provides is accurate and complete, and for six months after signing Ardent must negotiate exclusively with Corvane about the proposed collaboration.",
  },
  {
    rule: "Governing Law and Jurisdiction",
    heading: "Law and forum",
    standard:
      "The law of New South Wales, where Ardent is based, governs this agreement and the courts of New South Wales have jurisdiction, although either party may apply to any competent court for urgent injunctive relief.",
    fallback:
      "The laws of England and Wales govern this agreement and the courts of England and Wales have jurisdiction over any dispute arising from it.",
    unacceptable:
      "Any dispute must be resolved exclusively by confidential arbitration seated in Corvane's home city, and neither party may apply to any court, including for urgent injunctive relief.",
  },
  {
    rule: "Assignment",
    heading: "Transfers",
    standard:
      "Neither party may assign or transfer this agreement without the prior written consent of the other, except that Ardent may transfer it to one of its affiliates or to whoever succeeds to its business.",
    fallback:
      "Neither party may assign this agreement without the other's written consent, which must not be unreasonably withheld.",
    unacceptable:
      "Corvane may assign this agreement to any person, including a competitor of Ardent, without consent, and on assignment Corvane is released from all obligations, including for information already disclosed.",
  },
];

const MSA: ClauseSpec[] = [
  {
    rule: "Limitation of Liability Cap",
    heading: "Limits on liability",
    standard:
      "In each contract year, each party's total aggregate liability is capped at the greater of $2,000,000 and twice the fees paid or payable over the twelve months before the event that gave rise to the claim.",
    fallback:
      "Each party's aggregate liability under this agreement is limited to the greater of $1,000,000 and one and a half times the annual fees.",
    unacceptable:
      "The Supplier's total liability under this agreement is limited to the lower of the fees paid in the three months before the claim and the service credits payable. No cap applies to the Customer, and any fees the Customer owes count towards the Supplier's cap.",
  },
  {
    rule: "Exclusions from the Liability Cap",
    heading: "Unlimited liabilities",
    standard:
      "None of the liability limits applies to: personal injury or death resulting from negligence; fraud; wilful misconduct or abandonment of the services; breach of confidentiality; breach of data protection or security obligations; the Supplier's intellectual property indemnity; or any liability the law does not allow to be limited.",
    fallback:
      "Liability for breach of data protection, security or confidentiality obligations is subject to a separate cap of the greater of $5,000,000 and three times the annual fees, and the Supplier's intellectual property indemnity is unlimited.",
    unacceptable:
      "No exclusions from the liability cap apply except those the law requires. Losses from a data breach and the intellectual property indemnity fall within the general cap, and regulatory fines and breach response costs are treated as consequential loss.",
  },
  {
    rule: "Consequential Loss",
    heading: "Indirect loss",
    standard:
      "Neither party is liable for indirect or consequential loss, being loss that would not ordinarily flow from the breach. The following count as direct losses and may be recovered: the cost of replacement services, remediation and restoring data, the cost of responding to a breach, regulatory fines where the law allows, and wasted expenditure.",
    fallback:
      "Neither party is liable for loss of profits, revenue or goodwill or for indirect loss, but data restoration costs, breach response costs and the extra cost of obtaining replacement services may always be recovered.",
    unacceptable:
      "Neither party is liable for any loss of data or any loss of profits, whether direct or indirect, or for any loss exceeding the fees paid, all of which is treated as consequential loss.",
  },
  {
    rule: "IP Ownership of Deliverables",
    heading: "Ownership of work product",
    standard:
      "The Customer owns all deliverables created specifically for it, and all Customer data and outputs, as soon as they are created. The Supplier keeps its pre-existing intellectual property and generic tools and gives the Customer a perpetual, irrevocable licence, free of royalties, for any of those items built into the deliverables.",
    fallback:
      "The Supplier owns its platform and any general improvements to it. The Customer owns its data and, once paid for, any bespoke deliverables, and the Supplier licenses any embedded Supplier materials to the Customer perpetually for its business purposes.",
    unacceptable:
      "The Supplier owns all deliverables, all outputs generated from Customer data and all bespoke work, and may reuse them for other customers, including competitors of the Customer. The Customer's licence to use the deliverables ends when this agreement ends.",
  },
  {
    rule: "IP Indemnity",
    heading: "Infringement claims",
    standard:
      "The Supplier will defend and indemnify the Customer, without limit, if a third party claims that the services, software or deliverables infringe its intellectual property rights. The Supplier's options to modify the services, obtain a licence or replace them are in addition to this indemnity, and if none of them works the Supplier must refund prepaid fees.",
    fallback:
      "The Supplier indemnifies the Customer against third-party claims that the services infringe intellectual property rights, up to a separate cap of three times the annual fees. The indemnity does not cover infringement caused by Customer modifications, combinations with items the Supplier did not supply or specify, or materials the Customer provided.",
    unacceptable:
      "If the services infringe a third party's rights, the Customer's only remedy is to terminate and receive a refund of unused fees. The Customer indemnifies the Supplier against all claims arising from the Customer's use of the services.",
  },
  {
    rule: "Warranties",
    heading: "Supplier promises",
    standard:
      "The Supplier warrants that the services will be performed with reasonable skill and care by suitably qualified personnel, will materially conform to the documentation and specifications throughout the term, will comply with applicable law and will be free of malicious code. If it breaches a warranty the Customer may require re-performance, obtain a refund and use its other remedies.",
    fallback:
      "The Supplier warrants that one-off deliverables will conform to their specifications for 90 days after delivery, and that the ongoing services will be performed with reasonable skill and care and will not contain malicious code.",
    unacceptable:
      "The services are provided as is. All implied terms and warranties are excluded and none is given in their place. The Supplier may change the documentation at any time, and re-performance is the Customer's sole and exclusive remedy.",
  },
  {
    rule: "Service Levels and Service Credits",
    heading: "Availability",
    standard:
      "The services must be available for at least 99.9% of each month, the response and resolution times for each severity level in Schedule 3 must be met, and the Supplier must report performance monthly. Service credits are applied automatically and do not limit the Customer's other remedies, and repeated or serious failures entitle the Customer to terminate.",
    fallback:
      "The Supplier must achieve monthly availability of 99.5%. Service credits are the Customer's sole financial remedy for availability failures, but if availability falls below target three times in any six months the Customer may terminate.",
    unacceptable:
      "The Supplier gives no service level commitment. Any service credits it chooses to offer are the Customer's sole and exclusive remedy for every performance failure and must be claimed within five days.",
  },
  {
    rule: "Payment Terms",
    heading: "Invoices",
    standard:
      "The Customer will pay each valid invoice it does not dispute within 45 days after receipt. It may hold back any amount it disputes in good faith until the dispute is settled, and the Supplier must not suspend the services over a disputed amount.",
    fallback:
      "Invoices are payable within 30 days of receipt of a valid invoice. The Customer may withhold amounts it disputes in good faith if it notifies the Supplier of the dispute and its reasons.",
    unacceptable:
      "Invoices are payable within 14 days. The Supplier may suspend the services immediately if any amount is late, interest accrues on late amounts at 2% per month, and all future fees for the term become payable at once if the Customer breaches this agreement.",
  },
  {
    rule: "Price Increases",
    heading: "Changes to fees",
    standard:
      "No fee increase may take effect during the initial term. On renewal the Supplier may raise the fees only after at least 90 days' written notice ahead of the renewal date, and by no more than the lower of 3% and the movement in the consumer price index.",
    fallback:
      "On each renewal the Supplier may increase the fees by no more than the change in the consumer price index plus 2%, on 60 days' notice.",
    unacceptable:
      "The Supplier may change its fees at any time, including during the initial term, by publishing new prices on its website.",
  },
  {
    rule: "Term and Renewal",
    heading: "Duration",
    standard:
      "This agreement runs for an initial term of three years. After that it renews for one year at a time, but the Customer may opt out by notice given no later than 30 days before any renewal date, and the Supplier must send a renewal reminder at least 60 days in advance.",
    fallback:
      "After the initial term, this agreement renews automatically for successive one-year terms unless either party gives at least 60 days' notice of non-renewal, and the Supplier will send a renewal reminder.",
    unacceptable:
      "This agreement renews automatically for successive three-year terms at the Supplier's then-current list prices unless the Customer gives notice at least 180 days before renewal.",
  },
  {
    rule: "Termination for Convenience",
    heading: "Ending without cause",
    standard:
      "The Customer may end this agreement, or any order under it, for convenience by giving 30 days' written notice. It pays only for services delivered up to the termination date and receives a refund of fees prepaid for any later period. The Supplier has no right to terminate for convenience.",
    fallback:
      "The Customer may terminate this agreement for convenience on 90 days' written notice and will receive a pro-rata refund of any prepaid fees.",
    unacceptable:
      "The Supplier may terminate this agreement for convenience on seven days' notice. The Customer may not terminate before the end of the term, and if it does it must pay all fees for the rest of the term and forfeits any prepaid fees.",
  },
  {
    rule: "Termination for Cause",
    heading: "Ending for breach",
    standard:
      "Either party may end this agreement if the other materially breaches it and fails to fix the breach within 30 days after notice, or immediately if the other becomes insolvent, to the extent the law permits. The Customer may also terminate if the Supplier repeatedly fails the service levels, suffers a serious data or security breach, comes under the control of a competitor of the Customer, or if a regulator directs it.",
    fallback:
      "Either party may terminate for a material breach not remedied within 30 days of notice or if the other party becomes insolvent, and the Customer may also terminate for chronic failure to meet the service levels.",
    unacceptable:
      "The Supplier may suspend or terminate the services without notice for any breach by the Customer, including non-payment of amounts the Customer disputes. The Supplier has 90 days to remedy any breach of its own, and the Customer has no right to terminate because of a data breach.",
  },
  {
    rule: "Transition Assistance",
    heading: "Exit",
    standard:
      "When this agreement expires or ends for any reason, the Supplier must provide reasonable transition assistance for up to 12 months at its then-current rates, continue the services on the same terms during that period, and return all Customer data in a usable, standard format at no charge.",
    fallback:
      "On termination the Supplier will provide transition assistance for up to six months at the agreed rates and, within 30 days, will export all Customer data in a standard format at no charge.",
    unacceptable:
      "The Supplier will delete all Customer data immediately when this agreement ends. Any data export is available only in the Supplier's proprietary format, for an additional fee, and only once all amounts invoiced, including disputed amounts, have been paid.",
  },
  {
    rule: "Data Protection",
    heading: "Customer personal data",
    standard:
      "The Supplier will handle Customer personal data solely as the Customer instructs in writing and to provide the services, under a data processing agreement that complies with applicable law. It will not sell the data or put it to any secondary use, such as training models, will use only approved subprocessors, will notify the Customer of any breach within 48 hours, will help the Customer respond to individuals and regulators, and will return or delete the data at the end.",
    fallback:
      "The Supplier's standard data processing agreement applies, provided it meets the legal minimum under the governing law, requires breach notification without undue delay and prohibits any secondary use of Customer data.",
    unacceptable:
      "The Supplier acts as an independent controller of any personal data the Customer provides and may use it to train its models and for analytics it sells to third parties. The Supplier's privacy policy, as updated from time to time, applies instead of any data processing terms.",
  },
  {
    rule: "Processor Terms (EU/UK GDPR)",
    heading: "European processing terms",
    standard:
      "For personal data subject to the EU or UK GDPR, the data processing agreement includes every term required by Article 28(3): processing only on documented instructions, confidentiality of personnel, Article 32 security, prior authorisation and flow-down for subprocessors, help with data subject rights and with Articles 32 to 36, deletion or return at the end, and audit and information rights. Transfers outside the EEA or UK rely on adequacy, the Standard Contractual Clauses or the UK Addendum, backed by a transfer risk assessment.",
    fallback:
      "The Supplier's standard data processing agreement applies to EU and UK personal data if it contains every element required by Article 28(3) GDPR. The Customer gives general written authorisation for subprocessors, with 30 days' notice of any new subprocessor and a right to object, and transfers rely on an approved transfer mechanism.",
    unacceptable:
      "The Supplier may appoint new subprocessors without notice and may transfer EU personal data to any country without a transfer mechanism. The Customer has no right to audit the Supplier's processing, and the Supplier may process the data for its own purposes.",
  },
  {
    rule: "Privacy Act Compliance (AU)",
    heading: "Australian privacy",
    standard:
      "When it handles Customer personal information, the Supplier must meet the Australian Privacy Principles to the same standard as an APP entity, use the information only for the services, not disclose it outside Australia without the Customer's consent and safeguards meeting APP 8, notify any suspected eligible data breach within 48 hours, and return or destroy the information at the end.",
    fallback:
      "The Supplier will comply with the Australian Privacy Principles, notify the Customer of any data breach without undue delay and in any case within 72 hours, and disclose personal information overseas only to the locations listed in Schedule 4.",
    unacceptable:
      "The Supplier relies on the small business exemption under the Privacy Act and accepts no obligations in relation to personal information, which it may store or access from any country and use for direct marketing.",
  },
  {
    rule: "Information Security",
    heading: "Security",
    standard:
      "The Supplier must maintain a written information security programme certified to ISO/IEC 27001 or reported under SOC 2 Type II, encrypt Customer data both when stored and when transmitted, apply least-privilege access and multi-factor authentication, carry out penetration tests every year and share summaries of the results, notify security incidents within 48 hours, and not reduce its security during the term.",
    fallback:
      "The Supplier will maintain its current ISO/IEC 27001 certification throughout the term and will supply its annual certification and audit report to the Customer on request.",
    unacceptable:
      "The Supplier will take commercially reasonable security measures, which it may change at any time without notice. The Customer is responsible for the security of its data on the Supplier's systems, and the Supplier has no duty to notify security incidents.",
  },
  {
    rule: "Audit Rights",
    heading: "Inspections",
    standard:
      "The Customer, and any regulator of the Customer, may inspect whether the Supplier is complying with this agreement, including its security and data protection, once a year on reasonable notice and at any time after an incident or regulatory request. Each party bears its own costs, and the Supplier must fix any non-compliance at its own cost.",
    fallback:
      "Once a year, on 30 days' notice, the Customer may audit the Supplier's records and systems relevant to the services, and current independent certifications will satisfy routine audits.",
    unacceptable:
      "The Customer has no right to audit the Supplier, and the Supplier will not give access to any regulator of the Customer.",
  },
  {
    rule: "Subcontracting",
    heading: "Use of third parties",
    standard:
      "The Supplier may subcontract any part of the services only with the Customer's prior written consent. It remains fully responsible for its subcontractors and must impose on them all relevant obligations in this agreement, including those on confidentiality, security and data protection.",
    fallback:
      "The Supplier may use the subcontractors listed in Schedule 5 and must notify the Customer of any new material subcontractor. The Customer may object on reasonable grounds and, if the objection is not resolved, terminate the affected services without penalty.",
    unacceptable:
      "The Supplier may subcontract any of its obligations to anyone without notice, is not responsible for the acts of its subcontractors or its hosting providers, and need not bind them to any obligations equivalent to these.",
  },
  {
    rule: "Insurance",
    heading: "Cover",
    standard:
      "For the term and a reasonable run-off period afterwards, the Supplier must hold professional indemnity or technology errors and omissions insurance, cyber insurance, public and product liability insurance, and statutory workers' compensation cover, each with reputable insurers and limits appropriate to this agreement, and must provide certificates of currency on request.",
    fallback:
      "The Supplier will hold professional indemnity and cyber insurance with limits at least equal to the liability cap and the data breach cap, and will provide certificates on request.",
    unacceptable:
      "The Supplier is not required to hold any insurance. If it does hold insurance, the limits of that cover are the most it is liable to pay, and it may cancel the cover without telling the Customer.",
  },
  {
    rule: "Confidentiality and Publicity",
    heading: "Secrecy and announcements",
    standard:
      "Each party must keep the other's non-public information secret while this agreement runs and for five years after it ends, with no time limit for trade secrets and personal data. Also, neither party will use the other's name or logo, or announce this relationship, unless the other has first agreed in writing.",
    fallback:
      "Each party will treat the other's confidential information as secret while this agreement runs and for three years after it ends, with no time limit for trade secrets and personal data, subject to the usual exceptions and a right to keep copies in routine backups.",
    unacceptable:
      "Only the Supplier's confidential information is protected, and that protection ends when this agreement ends. The Supplier may name the Customer as a client, use its logo and publish case studies about the services without consent.",
  },
  {
    rule: "Governing Law and Jurisdiction",
    heading: "Law and disputes",
    standard:
      "The law of New South Wales, where the Customer is based, governs this agreement, and its courts have exclusive jurisdiction. Before starting proceedings the parties must escalate any dispute to their executives and may then try mediation, but either party may seek urgent injunctive relief at any time.",
    fallback:
      "English law governs this agreement and the parties submit to the courts of England and Wales.",
    unacceptable:
      "The law of the Republic of Esterra, where the Supplier is incorporated, governs this agreement and its courts have exclusive jurisdiction. Any claim must be brought within six months, and the Customer waives any right to seek injunctive relief.",
  },
  {
    rule: "Assignment and Change of Control",
    heading: "Transfers and ownership changes",
    standard:
      "The Supplier may not assign, novate or otherwise transfer this agreement unless the Customer first consents in writing. The Customer may transfer it to an affiliate or a successor by giving notice. If control of the Supplier changes, and in particular if a competitor of the Customer acquires it, the Customer may terminate without penalty.",
    fallback:
      "Neither party may assign this agreement without the other's consent, which must not be unreasonably withheld. The Customer may terminate without penalty if control of the Supplier changes.",
    unacceptable:
      "The Supplier may assign this agreement to any person without consent. The Customer may not assign it, including within its group, and has no right to terminate if the Supplier is acquired by one of its competitors.",
  },
  {
    rule: "Force Majeure",
    heading: "Events outside a party's control",
    standard:
      "A party is excused from performing only while an event outside its reasonable control prevents it, and only if reasonable precautions, including following its business continuity and disaster recovery plans, could not have avoided the event. It must notify the other promptly and mitigate the effects, fees for affected services are suspended, and the Customer may terminate if the event lasts more than 30 days.",
    fallback:
      "Neither party is liable for delay caused by events beyond its reasonable control. Fees are not payable for services not provided, and either party may terminate if the event continues for more than 60 days.",
    unacceptable:
      "Force majeure includes failures of the Supplier's subcontractors, cyber attacks of any kind and strikes by the Supplier's own staff. During such an event the Customer must keep paying the fees in full, the Supplier is relieved of its business continuity obligations, and there is no right to terminate however long the event lasts.",
  },
  {
    rule: "Non-Solicitation",
    heading: "Personnel",
    standard:
      "Nothing in this agreement prevents the Customer from soliciting or hiring any member of the Supplier's personnel.",
    fallback:
      "During the term and for six months afterwards, neither party will actively solicit personnel of the other who were directly involved in the services, but general advertisements and unsolicited approaches are not restricted.",
    unacceptable:
      "During the term and for two years afterwards, the Customer must not hire any employee of the Supplier, including people who apply on their own initiative, and must pay a placement fee of 50% of first-year salary for any person hired in breach.",
  },
];

const NDA_UNUSUAL: Unusual[] = [
  {
    key: "first_refusal",
    heading: "Right of first refusal",
    text: "If Ardent decides to sell any business unit during the two years after signing, it must first offer that business unit to Corvane on the same terms it proposes to accept from any third party.",
  },
  {
    key: "most_favoured",
    heading: "Preferred terms",
    text: "For three years after signing, if Ardent buys any product or service of the kind discussed under this agreement from another supplier, it must first offer Corvane the chance to supply it on terms no less favourable to Corvane than those given to that supplier.",
  },
  {
    key: "non_compete",
    heading: "Competing products",
    text: "During the discussions and for eighteen months afterwards, Ardent must not develop, buy or use any product that competes with Corvane's evaluation platform.",
  },
  {
    key: "evaluation_fee",
    heading: "Evaluation fee",
    text: "Ardent must pay Corvane an evaluation fee of $25,000 within 30 days of signing, which is not refundable in any circumstances.",
  },
  {
    key: "costs_shift",
    heading: "Dispute costs",
    text: "Ardent must reimburse Corvane's legal costs of any dispute about this agreement, whatever the outcome of that dispute.",
  },
  {
    key: "receivables_carve_out",
    heading: "Financing transfers",
    text: "Despite any restriction on transfer in this agreement, Corvane may transfer its rights under it, together with any Ardent information it holds, to any purchaser of its accounts receivable without notice to Ardent.",
  },
];

const MSA_UNUSUAL: Unusual[] = [
  {
    key: "minimum_commitment",
    heading: "Minimum spend",
    text: "The Customer must buy services worth at least $750,000 in each contract year and must pay any shortfall within 30 days after the end of that year.",
  },
  {
    key: "most_favoured",
    heading: "Preferred provider terms",
    text: "The Customer must offer the Supplier any work of the kind covered by this agreement on terms no less favourable than those the Customer offers any other provider.",
  },
  {
    key: "non_compete",
    heading: "Competing software",
    text: "During the term and for two years afterwards, the Customer must not develop internally or buy from any third party any software that competes with the Supplier's platform.",
  },
  {
    key: "unilateral_amendment",
    heading: "Updates to these terms",
    text: "The Supplier may amend any part of this agreement by posting a revised version on its website, and the Customer's continued use of the services is acceptance of the amended terms.",
  },
  {
    key: "receivables_carve_out",
    heading: "Financing of receivables",
    text: "Despite any restriction on transfer in this agreement, the Supplier may transfer its right to receive payments under it, together with any Customer data needed to collect them, to any financier or debt purchaser without notice.",
  },
  {
    key: "exclusivity",
    heading: "Exclusive appointment",
    text: "The Customer appoints the Supplier as its exclusive provider of analytics services worldwide for the term.",
  },
];

// {us} and {them} name the parties; each edit changes who bears a cost, a time or a right.
const BOILERPLATE: Boilerplate[] = [
  {
    key: "notices",
    heading: "Notices",
    text: "A notice is treated as received two business days after it is sent by email to the address in the Details.",
    edited:
      "A notice is treated as received when it is sent by email, whether or not it reaches the address in the Details.",
  },
  {
    key: "variation",
    heading: "Variation",
    text: "This agreement may be varied only by a document signed by both parties.",
    edited: "This agreement may be varied by {them} giving written notice to {us}.",
  },
  {
    key: "costs",
    heading: "Costs",
    text: "Each party bears its own costs of negotiating and signing this agreement.",
    edited: "{us} bears both parties' costs of negotiating and signing this agreement.",
  },
  {
    key: "waiver",
    heading: "Waiver",
    text: "A failure or delay in exercising a right does not waive that right.",
    edited: "A failure to exercise a right within 30 days waives that right.",
  },
  {
    key: "entire_agreement",
    heading: "Entire agreement",
    text: "This agreement is the entire agreement about its subject matter and replaces all earlier understandings.",
    edited:
      "This agreement is the entire agreement about its subject matter and replaces all earlier understandings, except {them}'s standard terms of business, which also apply and prevail over this agreement.",
  },
  {
    key: "agency",
    heading: "Relationship",
    text: "Neither party may make commitments on behalf of the other.",
    edited:
      "{them} may make commitments on behalf of {us} in dealings with {them}'s subcontractors.",
  },
  {
    key: "counterparts",
    heading: "Counterparts",
    text: "This agreement may be signed in counterparts, which together form one document.",
    edited:
      "This agreement may be signed in counterparts, which together form one document, and binds {us} once {us} has signed it even if {them} never signs.",
  },
  {
    key: "severance",
    heading: "Severance",
    text: "If any provision is unenforceable it is severed and the rest of this agreement continues in force.",
    edited:
      "If any provision protecting {them} is unenforceable, {us} must agree a replacement provision with the same effect.",
  },
];

export const CLAUSES: Record<Template, readonly ClauseSpec[]> = { nda: NDA, msa: MSA };
export const UNUSUAL: Record<Template, readonly Unusual[]> = { nda: NDA_UNUSUAL, msa: MSA_UNUSUAL };
export { BOILERPLATE };
