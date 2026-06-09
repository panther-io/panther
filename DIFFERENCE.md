Differenze rimaste:

isolation: { perSubject: true } viene accettato nella DX, ma per ora non crea automaticamente un runtime di isolamento reale; serve ancora un Isolation concreto se vuoi isolamento effettivo.

Quindi: per scrivere codice in quello stile, sì. Per avere anche isolamento automatico, manca ancora quel comportamento runtime.
