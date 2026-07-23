import json

# Each: symbol, atomic number, group(col 1-18), period(row 1-7), category
# Lanthanides/actinides placed in two extra rows (period 9,10) spanning cols 3-17
els = [
 ("H",1,1,1,"nonmetal"),("He",2,18,1,"noble"),
 ("Li",3,1,2,"alkali"),("Be",4,2,2,"alkaline"),("B",5,13,2,"metalloid"),("C",6,14,2,"nonmetal"),("N",7,15,2,"nonmetal"),("O",8,16,2,"nonmetal"),("F",9,17,2,"halogen"),("Ne",10,18,2,"noble"),
 ("Na",11,1,3,"alkali"),("Mg",12,2,3,"alkaline"),("Al",13,13,3,"postt"),("Si",14,14,3,"metalloid"),("P",15,15,3,"nonmetal"),("S",16,16,3,"nonmetal"),("Cl",17,17,3,"halogen"),("Ar",18,18,3,"noble"),
 ("K",19,1,4,"alkali"),("Ca",20,2,4,"alkaline"),("Sc",21,3,4,"transition"),("Ti",22,4,4,"transition"),("V",23,5,4,"transition"),("Cr",24,6,4,"transition"),("Mn",25,7,4,"transition"),("Fe",26,8,4,"transition"),("Co",27,9,4,"transition"),("Ni",28,10,4,"transition"),("Cu",29,11,4,"transition"),("Zn",30,12,4,"transition"),("Ga",31,13,4,"postt"),("Ge",32,14,4,"metalloid"),("As",33,15,4,"metalloid"),("Se",34,16,4,"nonmetal"),("Br",35,17,4,"halogen"),("Kr",36,18,4,"noble"),
 ("Rb",37,1,5,"alkali"),("Sr",38,2,5,"alkaline"),("Y",39,3,5,"transition"),("Zr",40,4,5,"transition"),("Nb",41,5,5,"transition"),("Mo",42,6,5,"transition"),("Tc",43,7,5,"transition"),("Ru",44,8,5,"transition"),("Rh",45,9,5,"transition"),("Pd",46,10,5,"transition"),("Ag",47,11,5,"transition"),("Cd",48,12,5,"transition"),("In",49,13,5,"postt"),("Sn",50,14,5,"postt"),("Sb",51,15,5,"metalloid"),("Te",52,16,5,"metalloid"),("I",53,17,5,"halogen"),("Xe",54,18,5,"noble"),
 ("Cs",55,1,6,"alkali"),("Ba",56,2,6,"alkaline"),("La",57,3,9,"lanth"),("Ce",58,4,9,"lanth"),("Pr",59,5,9,"lanth"),("Nd",60,6,9,"lanth"),("Pm",61,7,9,"lanth"),("Sm",62,8,9,"lanth"),("Eu",63,9,9,"lanth"),("Gd",64,10,9,"lanth"),("Tb",65,11,9,"lanth"),("Dy",66,12,9,"lanth"),("Ho",67,13,9,"lanth"),("Er",68,14,9,"lanth"),("Tm",69,15,9,"lanth"),("Yb",70,16,9,"lanth"),("Lu",71,17,9,"lanth"),
 ("Hf",72,4,6,"transition"),("Ta",73,5,6,"transition"),("W",74,6,6,"transition"),("Re",75,7,6,"transition"),("Os",76,8,6,"transition"),("Ir",77,9,6,"transition"),("Pt",78,10,6,"transition"),("Au",79,11,6,"transition"),("Hg",80,12,6,"transition"),("Tl",81,13,6,"postt"),("Pb",82,14,6,"postt"),("Bi",83,15,6,"postt"),("Po",84,16,6,"postt"),("At",85,17,6,"halogen"),("Rn",86,18,6,"noble"),
 ("Fr",87,1,7,"alkali"),("Ra",88,2,7,"alkaline"),("Ac",89,3,10,"act"),("Th",90,4,10,"act"),("Pa",91,5,10,"act"),("U",92,6,10,"act"),("Np",93,7,10,"act"),("Pu",94,8,10,"act"),("Am",95,9,10,"act"),("Cm",96,10,10,"act"),("Bk",97,11,10,"act"),("Cf",98,12,10,"act"),("Es",99,13,10,"act"),("Fm",100,14,10,"act"),("Md",101,15,10,"act"),("No",102,16,10,"act"),("Lr",103,17,10,"act"),
 ("Rf",104,4,7,"transition"),("Db",105,5,7,"transition"),("Sg",106,6,7,"transition"),("Bh",107,7,7,"transition"),("Hs",108,8,7,"transition"),("Mt",109,9,7,"transition"),("Ds",110,10,7,"transition"),("Rg",111,11,7,"transition"),("Cn",112,12,7,"transition"),("Nh",113,13,7,"postt"),("Fl",114,14,7,"postt"),("Mc",115,15,7,"postt"),("Lv",116,16,7,"postt"),("Ts",117,17,7,"halogen"),("Og",118,18,7,"noble"),
]

colors = {
 "alkali":"#cc6666","alkaline":"#e08a5a","transition":"#ffcc66","postt":"#b3b3cc",
 "metalloid":"#66b3a1","nonmetal":"#8fc98f","halogen":"#7fbf7f","noble":"#9999ff",
 "lanth":"#cc99cc","act":"#c07fb0",
}

# layout
cw, ch = 50, 46
gx, gy = 2, 2
ox, oy = 8, 44   # origin offset; leave room for title area at top

def cell_x(g): return ox + (g-1)*(cw+gx)
def cell_y(p):
    if p<=7: return oy + (p-1)*(ch+gy)
    # lanth row 9 -> visual row after gap, actinide row 10
    return oy + (7*(ch+gy)) + 18 + (p-9)*(ch+gy)

parts=[]
totw = ox + 18*(cw+gx) + 6
toth = cell_y(10)+ch+6
parts.append(f'<svg viewBox="0 0 {totw} {toth}" xmlns="http://www.w3.org/2000/svg">')

for sym,num,g,p,cat in els:
    x=cell_x(g); y=cell_y(p); c=colors[cat]
    parts.append(f'<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="4" fill="none" stroke="{c}" stroke-width="1.5"/>')
    parts.append(f'<text x="{x+4}" y="{y+13}" font-size="9" fill="#f5f6fa">{num}</text>')
    parts.append(f'<text x="{x+cw/2}" y="{y+33}" font-size="18" fill="{c}" text-anchor="middle" font-weight="bold">{sym}</text>')

# connector dots for La/Ac position
for (g,p,txt) in [(3,6,"57-71"),(3,7,"89-103")]:
    x=cell_x(g); y=cell_y(p)
    parts.append(f'<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="4" fill="none" stroke="#cc99cc" stroke-width="1" stroke-dasharray="3 3"/>')
    parts.append(f'<text x="{x+cw/2}" y="{y+28}" font-size="10" fill="#cc99cc" text-anchor="middle">{txt}</text>')

# legend
lx = cell_x(3); ly = cell_y(9) - 20
legend=[("Alkali","alkali"),("Alkaline","alkaline"),("Transition","transition"),("Post-transition","postt"),("Metalloid","metalloid"),("Nonmetal","nonmetal"),("Halogen","halogen"),("Noble gas","noble"),("Lanthanide","lanth"),("Actinide","act")]
# place legend along the top-right empty area (rows 1-3, cols 3-12 are empty)
lx0 = cell_x(4); ly0 = cell_y(1)+6
col=0
for i,(name,cat) in enumerate(legend):
    cx = lx0 + (i%5)*(2*(cw+gx))
    cy = ly0 + (i//5)*22
    parts.append(f'<rect x="{cx}" y="{cy}" width="14" height="14" rx="2" fill="{colors[cat]}"/>')
    parts.append(f'<text x="{cx+20}" y="{cy+12}" font-size="12" fill="#f5f6fa">{name}</text>')

parts.append('</svg>')
svg="".join(parts)
print(json.dumps({"svg":svg}))
