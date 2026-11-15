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
      '"Confidential Information" covers every non-public item that either side, or anyone on its behalf, shares for the Purpose, whether spoken, written or shown and whether labelled or not, along with anything a sensible person would recognise as private, and the fact that the parties are talking and what they discuss.',
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
      "Nothing here restricts the Recipient's handling of material that has entered the public domain without any fault on its part, that it already held lawfully and free of restriction, that someone else under no duty of secrecy handed to it lawfully, that its own staff created without relying on or consulting the Discloser's material, or that the Discloser has cleared for release in a signed note.",
    unacceptable:
      "Information is excluded from these obligations if it is available to the public in any form or could be pieced together from public sources, if the Recipient comes to possess it by any means, or if the Recipient reasonably considers that it is not confidential.",
  },
  {
    rule: "Permitted Use and Need-to-Know Disclosure",
    heading: "Use and onward disclosure",
    standard:
      "The Recipient may draw on Confidential Information only to weigh up the proposed collaboration (the Purpose). Only its staff, directors and professional advisers who must see the material for the Purpose, and who already owe secrecy duties at least as strict as these, may be shown it, and the Recipient is answerable for any slip by any of them.",
    fallback:
      "Confidential Information may be used solely for the Purpose. Besides its own staff and advisers, the Recipient may share it with affiliates, contractors and financiers who require it for the Purpose, as long as each has agreed in writing to terms no less protective than these and the Recipient stays liable for whatever they do with it.",
    unacceptable:
      "The Recipient may exploit Confidential Information however it sees fit commercially, for instance to refine its own offerings or to teach its machine learning systems, and may share it with group companies and business partners without answering for what they do with it.",
  },
  {
    rule: "Compelled Disclosure",
    heading: "Disclosure required by law",
    standard:
      "If a law, regulation, court order or stock exchange rule requires the Recipient to disclose Confidential Information, the Recipient must, if lawful, tell the Discloser promptly, help the Discloser seek a protective order or other remedy, and disclose no more than is legally required.",
    fallback:
      "Where a law obliges the Recipient to hand over Confidential Information it may do so, but it must first warn the Discloser if the law allows a warning and giving one is feasible, and must try in a sensible way to keep what it hands over as narrow as it can.",
    unacceptable:
      "The Recipient may disclose Confidential Information to any government body that asks for it, formally or informally, or whenever the Recipient believes disclosure is advisable, and need not tell the Discloser.",
  },
  {
    rule: "Standard of Care",
    heading: "Protection of information",
    standard:
      "The Recipient must guard Confidential Information as carefully as it guards its own comparable material, and never below the level a prudent business would apply, with suitable technical and organisational safeguards in place. If it learns that anyone has seen or obtained the material without permission, it must tell the Discloser straight away.",
    fallback:
      "The Recipient must keep Confidential Information safe with the degree of care a prudent business would use, and must let the Discloser know within a sensible period of any leak it discovers.",
    unacceptable:
      "The Recipient will use commercially reasonable efforts to try to keep Confidential Information secure, is liable only for disclosures caused by its gross negligence or wilful misconduct, and has no duty to report any disclosure.",
  },
  {
    rule: "Term and Survival",
    heading: "Duration",
    standard:
      "This agreement covers information disclosed during the three years after it is signed. The duties of the Recipient last for five years after this agreement expires or ends, and for trade secrets and personal data they last while the information stays confidential or the Recipient holds it.",
    fallback:
      "Information shared during the first two years after signing is covered. The Recipient's duties end three years after that two-year window closes, save that trade secrets and personal data stay protected with no end date.",
    unacceptable:
      "The Recipient's obligations under this agreement end on the date this agreement expires or is terminated, including for any trade secrets.",
  },
  {
    rule: "Return and Destruction",
    heading: "Returning materials",
    standard:
      "If the Discloser asks, or once the Purpose is over, the Recipient must without delay hand back or securely erase every item of Confidential Information, including all reproductions, and then certify to the Discloser in a signed note that this has been done.",
    fallback:
      "When asked, or when the Purpose ends, the Recipient must hand back or erase the Confidential Information. It need not purge material sitting in automatic system backups or that a statute requires it to keep; that material stays bound by this agreement and may not be opened for anything else until the normal backup cycle overwrites it.",
    unacceptable:
      "The Recipient may keep copies of any Confidential Information indefinitely for its records, and those copies are not subject to the obligations in this agreement. The Recipient has no obligation to return any material.",
  },
  {
    rule: "No Licence or Transfer of IP",
    heading: "Ownership",
    standard:
      "The Discloser keeps ownership of everything it shares. Apart from permission to use it for the Purpose, the Recipient acquires no rights of any kind in the Discloser's patents, copyright, know-how or other intangible assets.",
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
      "Staff who properly saw the other side's material may go on using the general expertise and techniques they carry in their heads without notes, provided nobody set out to commit the material to memory. This gives no rights under any patent or copyright, and it never covers data about individuals, figures from accounts, product roadmaps or strategy papers, program code, security details or trade secrets.",
    unacceptable:
      "Whatever the other side's information its people can recall, with or without notes, including precise particulars, each party may put to any use it likes, building rival products included.",
  },
  {
    rule: "Remedies and Injunctive Relief",
    heading: "Remedies",
    standard:
      "Both parties recognise that a money award might not repair a breach of this agreement. The Discloser may therefore ask a court for an order stopping the breach, and need not show it has already suffered harm or lodge any bond or other security first; this sits alongside every other remedy it has.",
    fallback:
      "Either side may go to court for an order to stop or prevent a breach of this agreement.",
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
      "Where either party shares details about identifiable people, the Recipient may use them solely for the Purpose, must treat them as privacy legislation requires and keep them secure, and must alert the Discloser without undue delay if they are compromised. Before sharing anything about individuals beyond names and work contact details, the parties will sign a separate processing contract.",
    fallback:
      "Whichever party receives details about individuals must follow the privacy laws that govern them and must warn the other party if they are exposed. As only work email addresses and phone numbers are expected to change hands, no separate processing contract is needed for now.",
    unacceptable:
      "Personal information that Ardent discloses about its staff or customers is not Confidential Information, and Corvane may store and transfer it in any country without further safeguards.",
  },
  {
    rule: "No Warranty and No Obligation to Proceed",
    heading: "No commitment",
    standard:
      "All Confidential Information is supplied as is, with no warranty of any kind. Neither party has to sign any further agreement or complete any transaction, and no commitment arises unless it is recorded in a separate written agreement that both parties sign.",
    fallback:
      "No promise is given about the quality or accuracy of anything shared, other than each party's confirmation that it is free to share what it shares. Neither side is bound to go ahead with any deal unless both later sign a further document saying so.",
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
      "Neither side may hand this agreement to anyone else unless the other first agrees in writing, but Ardent may pass it to a company in its group or to whoever takes over its business.",
    fallback:
      "Each party needs the other's written agreement before handing this agreement to anyone else, and that agreement may not be refused without good reason.",
    unacceptable:
      "Corvane may assign this agreement to any person, including a competitor of Ardent, without consent, and on assignment Corvane is released from all obligations, including for information already disclosed.",
  },
];

const MSA: ClauseSpec[] = [
  {
    rule: "Limitation of Liability Cap",
    heading: "Limits on liability",
    standard:
      "For every contract year, neither party's combined exposure under this agreement may exceed whichever is higher: $2,000,000, or double the charges invoiced or due over the twelve months before the event that prompted the claim.",
    fallback:
      "Neither side's total exposure under this agreement may exceed $1,000,000 or one and a half years' charges, whichever is higher.",
    unacceptable:
      "The most the Supplier can ever owe is the smaller of three months' charges and the service credits due; the Customer has no ceiling at all, and charges the Customer owes are counted against the Supplier's ceiling.",
  },
  {
    rule: "Exclusions from the Liability Cap",
    heading: "Unlimited liabilities",
    standard:
      "The caps above do not protect a party that causes someone's death or injury through carelessness, acts dishonestly or deliberately, walks away from the services, discloses the other's secrets, fails in its privacy or security duties, or owes money under the Supplier's infringement indemnity; nor do they reach any liability the law forbids parties to cap.",
    fallback:
      "Claims for privacy, security or secrecy failures sit under their own higher ceiling of $5,000,000 or triple a year's charges, whichever is more, while the Supplier's infringement indemnity has no ceiling at all.",
    unacceptable:
      "No exclusions from the liability cap apply except those the law requires. Losses from a data breach and the intellectual property indemnity fall within the general cap, and regulatory fines and breach response costs are treated as consequential loss.",
  },
  {
    rule: "Consequential Loss",
    heading: "Indirect loss",
    standard:
      "Remote losses, meaning those that would not ordinarily flow from the breach, cannot be claimed by either side. Even so, a party may always recover what it spends buying substitute services, fixing the problem and rebuilding lost records, handling a security incident, paying regulators where the law lets it pass those penalties on, and money spent for nothing.",
    fallback:
      "Lost profit, turnover or reputation and remote losses are excluded for both sides, but rebuilding lost records, handling a security incident and the extra price of a substitute provider can always be claimed.",
    unacceptable:
      "Corrupted or missing records and every kind of lost profit, however closely they follow from the breach, can never be claimed, and any loss above the amount already invoiced is to be treated as remote and unrecoverable.",
  },
  {
    rule: "IP Ownership of Deliverables",
    heading: "Ownership of work product",
    standard:
      "Everything produced specially for the Customer, together with the Customer's records and anything generated from them, belongs to the Customer from the moment it comes into being. The Supplier keeps what it owned beforehand and its general-purpose tooling, and lets the Customer use any of it built into the work product forever, without charge and without any right to withdraw that permission.",
    fallback:
      "The platform and any general enhancements stay with the Supplier. The Customer's records are the Customer's, and custom work becomes the Customer's once paid for; any Supplier material built into that work may be used by the Customer for its business indefinitely.",
    unacceptable:
      "Title to every piece of work product, to anything generated from the Customer's records, and to custom work stays with the Supplier, which may hand the same material to other clients, rivals of the Customer included. The Customer's permission to use the work lapses on expiry or termination.",
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
      "The Supplier promises that competent, properly trained staff will deliver the services diligently and professionally, that the services will match their written description in all material respects for as long as this agreement lasts, that they will be lawful and that they will carry no viruses or other harmful code. If any promise is broken, the Customer can insist on the work being redone, get its money back and pursue any other remedy.",
    fallback:
      "For ninety days after handover, each one-time deliverable will match its specification; throughout, the continuing services will be delivered competently and diligently and will be free of viruses or harmful code.",
    unacceptable:
      "The Supplier makes no promises about the services, every term the law would otherwise imply is excluded, the written description may be cut back whenever the Supplier wishes, and redoing the work is all the Customer can ever ask for.",
  },
  {
    rule: "Service Levels and Service Credits",
    heading: "Availability",
    standard:
      "The services must be available for at least 99.9% of each month, the response and resolution times for each severity level in Schedule 3 must be met, and the Supplier must report performance monthly. Service credits are applied automatically and do not limit the Customer's other remedies, and repeated or serious failures entitle the Customer to terminate.",
    fallback:
      "Uptime must reach 99.5% each month. For missed uptime the credits are the only money the Customer can claim, but three missed months within any half-year let the Customer end this agreement.",
    unacceptable:
      "The Supplier gives no service level commitment. Any service credits it chooses to offer are the Customer's sole and exclusive remedy for every performance failure and must be claimed within five days.",
  },
  {
    rule: "Payment Terms",
    heading: "Invoices",
    standard:
      "A correct, uncontested invoice is due forty-five days after the Customer receives it. Sums the Customer honestly contests may be held back until the disagreement is resolved, and the Supplier may not cut off the services over them.",
    fallback:
      "A correct invoice falls due thirty days after it arrives. The Customer can hold back any part it honestly contests, so long as it tells the Supplier which part and why.",
    unacceptable:
      "Invoices are payable within 14 days. The Supplier may suspend the services immediately if any amount is late, interest accrues on late amounts at 2% per month, and all future fees for the term become payable at once if the Customer breaches this agreement.",
  },
  {
    rule: "Price Increases",
    heading: "Changes to fees",
    standard:
      "Charges cannot rise during the first term. When the agreement renews, the Supplier may raise them only after telling the Customer in writing at least ninety days beforehand, and never by more than 3% or the year's inflation figure, whichever is smaller.",
    fallback:
      "At each rollover the Supplier may lift its charges by no more than inflation plus two percentage points, after sixty days' warning.",
    unacceptable:
      "The Supplier may change its fees at any time, including during the initial term, by publishing new prices on its website.",
  },
  {
    rule: "Term and Renewal",
    heading: "Duration",
    standard:
      "The first term lasts three years. Afterwards the agreement rolls over a year at a time, but the Customer may stop any rollover by telling the Supplier no later than thirty days ahead, and the Supplier must send a written reminder no less than sixty days ahead.",
    fallback:
      "Once the first term ends, the agreement rolls over for twelve months at a time unless one side tells the other it wants out at least sixty days before a rollover; the Supplier will remind the Customer before each rollover.",
    unacceptable:
      "Every rollover is for another three years, charged at whatever the Supplier's price list says at that time, unless the Customer opts out at least 180 days ahead.",
  },
  {
    rule: "Termination for Convenience",
    heading: "Ending without cause",
    standard:
      "Without giving any reason, the Customer may end this agreement or a single order by giving thirty days' notice in writing. It owes only for work done up to the end date and gets back anything it paid in advance for later periods. The Supplier cannot end this agreement merely because it chooses to.",
    fallback:
      "Without giving any reason, the Customer may end this agreement on ninety days' written notice and will be repaid a proportionate share of charges it paid ahead of time.",
    unacceptable:
      "The Supplier may terminate this agreement for convenience on seven days' notice. The Customer may not terminate before the end of the term, and if it does it must pay all fees for the rest of the term and forfeits any prepaid fees.",
  },
  {
    rule: "Termination for Cause",
    heading: "Ending for breach",
    standard:
      "Either side may bring this agreement to an end if the other seriously breaches it and does not fix the problem within thirty days of being told, or straight away if the other goes insolvent, so far as the law allows. The Customer may also end it if uptime targets are missed again and again, if the Supplier suffers a grave security or privacy incident, if a rival of the Customer takes control of the Supplier, or if a regulator instructs it to.",
    fallback:
      "Either side may end this agreement if the other commits a serious breach and leaves it unfixed for thirty days after being told, or if the other goes insolvent; the Customer may also end it if uptime targets are missed again and again.",
    unacceptable:
      "The Supplier may suspend or terminate the services without notice for any breach by the Customer, including non-payment of amounts the Customer disputes. The Supplier has 90 days to remedy any breach of its own, and the Customer has no right to terminate because of a data breach.",
  },
  {
    rule: "Transition Assistance",
    heading: "Exit",
    standard:
      "However this agreement ends, the Supplier must help the Customer move to a new provider for up to a year at its prevailing charges, keep the services running on unchanged terms in the meantime, and hand back every Customer record in a common, readable file format for free.",
    fallback:
      "However this agreement ends, the Supplier will help with the move to a new provider for up to six months at the rates already agreed, and within a month will hand over all Customer records in a common file format for free.",
    unacceptable:
      "The Supplier will delete all Customer data immediately when this agreement ends. Any data export is available only in the Supplier's proprietary format, for an additional fee, and only once all amounts invoiced, including disputed amounts, have been paid.",
  },
  {
    rule: "Data Protection",
    heading: "Customer personal data",
    standard:
      "The Supplier will handle Customer personal data solely as the Customer instructs in writing and to provide the services, under a data processing agreement that complies with applicable law. It will not sell the data or put it to any secondary use, such as training models, will use only approved subprocessors, will notify the Customer of any breach within 48 hours, will help the Customer respond to individuals and regulators, and will return or delete the data at the end.",
    fallback:
      "The Supplier's usual processing terms will govern personal information, as long as they satisfy the minimum that local privacy law demands, require prompt reporting of any incident and bar the Supplier from putting Customer information to any other use.",
    unacceptable:
      "The Supplier acts as an independent controller of any personal data the Customer provides and may use it to train its models and for analytics it sells to third parties. The Supplier's privacy policy, as updated from time to time, applies instead of any data processing terms.",
  },
  {
    rule: "Processor Terms (EU/UK GDPR)",
    heading: "European processing terms",
    standard:
      "Where European or UK privacy law applies, the processing contract between the parties must contain every term that Article 28(3) lists: acting only on written instructions, keeping staff bound to secrecy, Article 32 safeguards, approving and binding any sub-processors, helping with individuals' requests and with Articles 32 to 36, erasing or handing back the information at the end, and allowing audits and supplying information. Moving that information abroad needs an adequacy finding, the Commission's model clauses or the UK addendum, backed by an assessment of the risks.",
    fallback:
      "The Supplier's usual processing contract may be used for European and UK information if nothing that Article 28(3) demands is missing. The Supplier may engage sub-processors under a blanket approval, but must give thirty days' warning of each new one so the Customer can object, and any transfer abroad must use a recognised legal route.",
    unacceptable:
      "The Supplier may appoint new subprocessors without notice and may transfer EU personal data to any country without a transfer mechanism. The Customer has no right to audit the Supplier's processing, and the Supplier may process the data for its own purposes.",
  },
  {
    rule: "Privacy Act Compliance (AU)",
    heading: "Australian privacy",
    standard:
      "For any personal information it holds for the Customer, the Supplier must follow the Australian Privacy Principles just as a regulated organisation would, use it solely to deliver the services, keep it within Australia unless the Customer agrees and the APP 8 protections are in place, report within two days any incident that may be a notifiable breach, and hand it back or wipe it when the agreement ends.",
    fallback:
      "The Supplier will follow the Australian Privacy Principles, tell the Customer about any privacy incident promptly and never later than three days after learning of it, and send personal information abroad only to the countries named in Schedule 4.",
    unacceptable:
      "The Supplier relies on the small business exemption under the Privacy Act and accepts no obligations in relation to personal information, which it may store or access from any country and use for direct marketing.",
  },
  {
    rule: "Information Security",
    heading: "Security",
    standard:
      "The Supplier must run a documented security programme certified under ISO/IEC 27001 or covered by a SOC 2 Type II report, encrypt Customer data both when stored and when transmitted, give each person only the access their job needs and require a second login factor, commission an external attack test every year and share a summary of what it found, report any incident within two days, and never weaken these protections while this agreement lasts.",
    fallback:
      "The Supplier will maintain its current ISO/IEC 27001 certification throughout the term and will supply its annual certification and audit report to the Customer on request.",
    unacceptable:
      "The Supplier will take commercially reasonable security measures, which it may change at any time without notice. The Customer is responsible for the security of its data on the Supplier's systems, and the Supplier has no duty to notify security incidents.",
  },
  {
    rule: "Audit Rights",
    heading: "Inspections",
    standard:
      "Once a year on fair warning, and at any time after an incident or a request from a regulator, the Customer or any authority that oversees it may inspect whether the Supplier is keeping to this agreement, its security and privacy terms included. Each side pays its own way, and the Supplier must put right any shortcoming at its own expense.",
    fallback:
      "The Customer may inspect the Supplier's books and systems that relate to the services once in any year, after giving thirty days' warning; in a normal year, up-to-date independent certificates will be enough.",
    unacceptable:
      "The Customer has no right to audit the Supplier, and the Supplier will not give access to any regulator of the Customer.",
  },
  {
    rule: "Subcontracting",
    heading: "Use of third parties",
    standard:
      "No part of the services may be handed to another firm unless the Customer has first agreed in writing. The Supplier answers for any such firm as if it had done the work itself, and must bind it to every relevant duty here, secrecy, security and privacy included.",
    fallback:
      "The Supplier may use the firms named in Schedule 5 and must tell the Customer before bringing in any other significant one. If the Customer raises a reasonable objection that cannot be settled, it may end the affected services with no penalty.",
    unacceptable:
      "The Supplier may hand any of its work to any other firm without telling the Customer, does not answer for what those firms or its hosting companies do, and need not hold them to duties like the ones here.",
  },
  {
    rule: "Insurance",
    heading: "Cover",
    standard:
      "While this agreement lasts and for a sensible period afterwards, the Supplier must carry professional negligence (or technology errors) cover, cyber cover, cover for injury and damage to third parties and from its products, and the employee injury cover the law requires, each placed with sound insurers and sized for this deal, and must show proof of cover when asked.",
    fallback:
      "The Supplier will carry professional negligence and cyber cover for no less than the general cap and the separate data breach cap, and will show proof of cover when asked.",
    unacceptable:
      "The Supplier is not required to hold any insurance. If it does hold insurance, the limits of that cover are the most it is liable to pay, and it may cancel the cover without telling the Customer.",
  },
  {
    rule: "Confidentiality and Publicity",
    heading: "Secrecy and announcements",
    standard:
      "Each side must keep the other's unpublished information to itself while this agreement runs and for five years afterwards, and must protect trade secrets and details about individuals forever. Neither side may mention the other in publicity, show its branding or reveal that they work together unless it has first obtained written permission.",
    fallback:
      "Each side will keep the other's private material to itself while this agreement runs and for three years afterwards, and forever for trade secrets and details about individuals, apart from the normal carve-outs and copies held in routine backups.",
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
      "The Supplier may not pass this agreement, or any part of it, to anyone else unless the Customer first agrees in writing, whereas the Customer may hand it to a group company or to whoever takes over its business by giving notice. If someone new gains control of the Supplier, above all a rival of the Customer, the Customer may end this agreement without any charge.",
    fallback:
      "Each side needs the other's agreement to pass this agreement on, which may not be refused without good reason, and if someone new gains control of the Supplier the Customer may end it without any charge.",
    unacceptable:
      "The Supplier may pass this agreement to whoever it likes without asking. The Customer may never pass it on, not even to another company in its group, and must stay bound even if one of its rivals buys the Supplier.",
  },
  {
    rule: "Force Majeure",
    heading: "Events outside a party's control",
    standard:
      "A party is excused only for as long as something outside its control stops it performing, and only if sensible precautions, including following its continuity and recovery plans, could not have avoided the problem. It must tell the other side at once and do what it can to limit the damage; charges for services not delivered are paused, and the Customer may end this agreement if the disruption lasts beyond thirty days.",
    fallback:
      "A delay caused by something neither side could reasonably control gives no claim; no charges are due for services that could not be supplied, and either side may walk away once the disruption has lasted sixty days.",
    unacceptable:
      "Force majeure includes failures of the Supplier's subcontractors, cyber attacks of any kind and strikes by the Supplier's own staff. During such an event the Customer must keep paying the fees in full, the Supplier is relieved of its business continuity obligations, and there is no right to terminate however long the event lasts.",
  },
  {
    rule: "Non-Solicitation",
    heading: "Personnel",
    standard:
      "Nothing in this agreement prevents the Customer from soliciting or hiring any member of the Supplier's personnel.",
    fallback:
      "While this agreement lasts and for six months afterwards, neither side will set out to recruit people of the other who worked on the services, although public job adverts and approaches made by the person unprompted are allowed.",
    unacceptable:
      "Until two years after this agreement ends, the Customer may not take on anyone employed by the Supplier, even someone who applies unprompted, and owes a recruitment charge of half that person's first-year pay for each breach.",
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
